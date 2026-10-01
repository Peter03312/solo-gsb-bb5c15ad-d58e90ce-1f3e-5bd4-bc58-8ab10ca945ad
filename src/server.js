'use strict';

const path = require('path');
const express = require('express');
const { get, tx, nowIso } = require('./db');
const {
  isValidDate,
  findPath,
  loadGraph,
  verifyPackage,
  verifyTourPackage,
  verifyStoredPackage,
  normalizeStops,
  loadStops,
  revalidatePublished,
} = require('./verify');
const { previewChange, commitChange, ChangeError } = require('./changes');
const { searchSchedule, applySchedule, ScheduleError } = require('./schedule');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const db = get();

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const str = (v) => (v === null || v === undefined ? '' : String(v));

function loadMaterial(id) {
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(id);
  if (!m) throw new HttpError(404, `素材 #${id} 不存在`);
  return m;
}

function materialDTO(m) {
  const sources = db
    .prepare(
      `SELECT l.id, l.relation, l.source_material_id AS sourceMaterialId, s.title AS sourceTitle
         FROM source_links l JOIN materials s ON s.id = l.source_material_id
        WHERE l.material_id=? ORDER BY l.id`
    )
    .all(m.id);
  const usedBy = db
    .prepare(
      `SELECT l.id, l.relation, l.material_id AS materialId, s.title AS materialTitle
         FROM source_links l JOIN materials s ON s.id = l.material_id
        WHERE l.source_material_id=? ORDER BY l.id`
    )
    .all(m.id);
  const authorizations = db
    .prepare('SELECT * FROM authorizations WHERE material_id=? ORDER BY id')
    .all(m.id)
    .map(authDTO);
  return {
    id: m.id,
    title: m.title,
    kind: m.kind,
    note: m.note,
    createdAt: m.created_at,
    sources,
    usedBy,
    authorizations,
  };
}

function authDTO(a) {
  return {
    id: a.id,
    materialId: a.material_id,
    media: a.media,
    region: a.region,
    validFrom: a.valid_from,
    validTo: a.valid_to,
    revoked: !!a.revoked,
    licensor: a.licensor,
    note: a.note,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

function stopDTO(s) {
  return {
    id: s.id,
    position: s.position,
    name: s.name,
    medium: s.medium,
    region: s.region,
    useFrom: s.use_from,
    useTo: s.use_to,
  };
}

function packageDTO(p, full = false) {
  const items = db
    .prepare(
      `SELECT m.id, m.title, m.kind
         FROM package_items i JOIN materials m ON m.id = i.material_id
        WHERE i.package_id=? ORDER BY i.position, i.material_id`
    )
    .all(p.id);
  const stops = db
    .prepare('SELECT * FROM package_stops WHERE package_id=? ORDER BY position')
    .all(p.id)
    .map(stopDTO);
  const latest = db
    .prepare('SELECT * FROM verification_snapshots WHERE package_id=? ORDER BY id DESC LIMIT 1')
    .get(p.id);
  const publishSnap = db
    .prepare("SELECT * FROM verification_snapshots WHERE package_id=? AND kind='publish' ORDER BY id DESC LIMIT 1")
    .get(p.id);
  // 多站包：packages 表上的单站字段为空，展期取首站起 → 末站止；旧包无 stops，视为单站
  const isTour = stops.length > 0;
  const effectiveFrom = isTour ? stops[0].useFrom : p.use_from;
  const effectiveTo = isTour ? stops[stops.length - 1].useTo : p.use_to;
  const dto = {
    id: p.id,
    name: p.name,
    kind: isTour ? 'tour' : 'single',
    medium: p.medium,
    region: p.region,
    useFrom: p.use_from,
    useTo: p.use_to,
    stops,
    stopCount: stops.length,
    effectiveFrom,
    effectiveTo,
    status: p.status,
    createdAt: p.created_at,
    publishedAt: p.published_at,
    updatedAt: p.updated_at,
    items,
    itemCount: items.length,
    latestSnapshot: latest
      ? { id: latest.id, kind: latest.kind, eligible: !!latest.eligible, basisVersion: latest.basis_version, createdAt: latest.created_at }
      : null,
    publishSnapshotId: publishSnap ? publishSnap.id : null,
    publishEligible: publishSnap ? !!publishSnap.eligible : null,
  };
  if (full) {
    dto.snapshots = db
      .prepare('SELECT id, kind, eligible, basis_version, created_at FROM verification_snapshots WHERE package_id=? ORDER BY id')
      .all(p.id)
      .map((s) => ({ id: s.id, kind: s.kind, eligible: !!s.eligible, basisVersion: s.basis_version, createdAt: s.created_at }));
  }
  return dto;
}

function validateScope(body) {
  // 前端字段名为 media（媒介），兼容 medium
  const medium = str(body.media ?? body.medium).trim();
  const region = str(body.region).trim();
  if (!medium) throw new HttpError(400, '媒介不能为空');
  if (!region) throw new HttpError(400, '地区不能为空');
  return { medium, region };
}

function validateDateRange(from, to) {
  if (!isValidDate(from)) throw new HttpError(400, `起始日期不合法：${from || '（空）'}（需为 YYYY-MM-DD）`);
  if (!isValidDate(to)) throw new HttpError(400, `截止日期不合法：${to || '（空）'}（需为 YYYY-MM-DD）`);
  if (from > to) throw new HttpError(400, `起止日期不合法：起始 ${from} 晚于截止 ${to}`);
}

// ---------- 概览 ----------
app.get('/api/state', (req, res) => {
  const basis = db.prepare("SELECT value FROM meta WHERE key='basis_version'").pluck().get();
  const materialCount = db.prepare('SELECT COUNT(*) FROM materials').pluck().get();
  const authorizationCount = db.prepare('SELECT COUNT(*) FROM authorizations').pluck().get();
  const packageCount = db.prepare('SELECT COUNT(*) FROM packages').pluck().get();
  const reviewCount = db.prepare("SELECT COUNT(*) FROM packages WHERE status='needs_review'").pluck().get();
  res.json({ basisVersion: Number(basis), materialCount, authorizationCount, packageCount, reviewCount });
});

// ---------- 素材 ----------
app.get('/api/materials', (req, res) => {
  const rows = db.prepare('SELECT * FROM materials ORDER BY id').all();
  res.json(rows.map(materialDTO));
});

app.get('/api/materials/:id', (req, res, next) => {
  try {
    res.json(materialDTO(loadMaterial(Number(req.params.id))));
  } catch (e) { next(e); }
});

app.post('/api/materials', (req, res, next) => {
  try {
    const title = str(req.body.title).trim();
    if (!title) throw new HttpError(400, '素材名称不能为空');
    const info = db.prepare('INSERT INTO materials(title, kind, note, created_at) VALUES (?,?,?,?)')
      .run(title, str(req.body.kind).trim() || null, str(req.body.note).trim() || null, nowIso());
    res.status(201).json(materialDTO(loadMaterial(info.lastInsertRowid)));
  } catch (e) { next(e); }
});

app.patch('/api/materials/:id', (req, res, next) => {
  try {
    const m = loadMaterial(Number(req.params.id));
    const title = req.body.title === undefined ? m.title : str(req.body.title).trim();
    if (!title) throw new HttpError(400, '素材名称不能为空');
    const kind = req.body.kind === undefined ? m.kind : str(req.body.kind).trim() || null;
    const note = req.body.note === undefined ? m.note : str(req.body.note).trim() || null;
    db.prepare('UPDATE materials SET title=?, kind=?, note=? WHERE id=?').run(title, kind, note, m.id);
    res.json(materialDTO(loadMaterial(m.id)));
  } catch (e) { next(e); }
});

app.delete('/api/materials/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    loadMaterial(id);
    const used = db.prepare('SELECT COUNT(*) FROM package_items WHERE material_id=?').pluck().get(id);
    if (used > 0) throw new HttpError(409, `素材 #${id} 已被 ${used} 个展览包（含不可变清单）引用，不可删除；请先从待发布包中移除或使用副本`);
    db.prepare('DELETE FROM materials WHERE id=?').run(id); // 授权与来源关系级联删除（会触发 basis 版本递增）
    tx(() => revalidatePublished(db));
    res.status(204).end();
  } catch (e) { next(e); }
});

// ---------- 来源关系（不得成环） ----------
app.post('/api/materials/:id/sources', (req, res, next) => {
  try {
    const materialId = Number(req.params.id);
    const sourceId = Number(req.body.sourceMaterialId);
    loadMaterial(materialId);
    loadMaterial(sourceId);
    if (materialId === sourceId) throw new HttpError(400, '素材不能以自身为来源');

    const dup = db
      .prepare('SELECT id FROM source_links WHERE material_id=? AND source_material_id=?')
      .get(materialId, sourceId);
    if (dup) throw new HttpError(409, '该来源关系已存在');

    // 成环预判：若 source 已能到达 material，再加 material->source 即成环
    const adj = loadGraph(db);
    const cyclePath = findPath(adj, sourceId, materialId);
    if (cyclePath) {
      throw new HttpError(409, '添加该来源将形成闭环（来源关系不得成环）', {
        cyclePath,                              // 既有可达路径：source -> … -> material
        cycle: [materialId, ...cyclePath],      // 完整闭环：material -> source -> … -> material
      });
    }

    tx(() => {
      db.prepare('INSERT INTO source_links(material_id, source_material_id, relation, created_at) VALUES (?,?,?,?)')
        .run(materialId, sourceId, str(req.body.relation).trim() || '使用', nowIso());
      revalidatePublished(db);
    });
    res.status(201).json(materialDTO(loadMaterial(materialId)));
  } catch (e) { next(e); }
});

app.delete('/api/source-links/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const link = db.prepare('SELECT * FROM source_links WHERE id=?').get(id);
    if (!link) throw new HttpError(404, `来源关系 #${id} 不存在`);
    tx(() => {
      db.prepare('DELETE FROM source_links WHERE id=?').run(id);
      revalidatePublished(db);
    });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ---------- 授权 ----------
app.post('/api/materials/:id/authorizations', (req, res, next) => {
  try {
    const materialId = Number(req.params.id);
    loadMaterial(materialId);
    const { medium, region } = validateScope(req.body);
    const validFrom = str(req.body.validFrom).trim();
    const validTo = str(req.body.validTo).trim();
    validateDateRange(validFrom, validTo);
    const revoked = req.body.revoked ? 1 : 0;
    const info = db
      .prepare(
        `INSERT INTO authorizations(material_id, media, region, valid_from, valid_to, revoked, licensor, note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(materialId, medium, region, validFrom, validTo, revoked,
        str(req.body.licensor).trim() || null, str(req.body.note).trim() || null, nowIso(), nowIso());
    tx(() => revalidatePublished(db));
    res.status(201).json(authDTO(db.prepare('SELECT * FROM authorizations WHERE id=?').get(info.lastInsertRowid)));
  } catch (e) { next(e); }
});

app.patch('/api/authorizations/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const a = db.prepare('SELECT * FROM authorizations WHERE id=?').get(id);
    if (!a) throw new HttpError(404, `授权 #${id} 不存在`);
    const medium = str(req.body.media ?? a.media).trim();
    const region = str(req.body.region ?? a.region).trim();
    const validFrom = str(req.body.validFrom ?? a.valid_from).trim();
    const validTo = str(req.body.validTo ?? a.valid_to).trim();
    const licensor = req.body.licensor === undefined ? a.licensor : str(req.body.licensor).trim() || null;
    const note = req.body.note === undefined ? a.note : str(req.body.note).trim() || null;
    if (!medium) throw new HttpError(400, '媒介不能为空');
    if (!region) throw new HttpError(400, '地区不能为空');
    validateDateRange(validFrom, validTo);
    const revoked = req.body.revoked === undefined ? a.revoked : (req.body.revoked ? 1 : 0);
    tx(() => {
      db.prepare(
        `UPDATE authorizations SET media=?, region=?, valid_from=?, valid_to=?, revoked=?, licensor=?, note=?, updated_at=? WHERE id=?`
      ).run(medium, region, validFrom, validTo, revoked, licensor, note, nowIso(), id);
      revalidatePublished(db);
    });
    res.json(authDTO(db.prepare('SELECT * FROM authorizations WHERE id=?').get(id)));
  } catch (e) { next(e); }
});

app.post('/api/authorizations/:id/revoke', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const a = db.prepare('SELECT * FROM authorizations WHERE id=?').get(id);
    if (!a) throw new HttpError(404, `授权 #${id} 不存在`);
    tx(() => {
      db.prepare('UPDATE authorizations SET revoked=1, updated_at=? WHERE id=?').run(nowIso(), id);
      revalidatePublished(db);
    });
    res.json(authDTO(db.prepare('SELECT * FROM authorizations WHERE id=?').get(id)));
  } catch (e) { next(e); }
});

app.delete('/api/authorizations/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const a = db.prepare('SELECT * FROM authorizations WHERE id=?').get(id);
    if (!a) throw new HttpError(404, `授权 #${id} 不存在`);
    tx(() => {
      db.prepare('DELETE FROM authorizations WHERE id=?').run(id);
      revalidatePublished(db);
    });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ---------- 展览包 ----------
app.get('/api/packages', (req, res) => {
  const rows = db.prepare('SELECT * FROM packages ORDER BY id DESC').all();
  res.json(rows.map((p) => packageDTO(p)));
});

app.get('/api/packages/:id', (req, res, next) => {
  try {
    const p = db.prepare('SELECT * FROM packages WHERE id=?').get(Number(req.params.id));
    if (!p) throw new HttpError(404, '展览包不存在');
    res.json(packageDTO(p, true));
  } catch (e) { next(e); }
});

// 归一化包请求：单站沿用旧字段（media/medium、region、useFrom/useTo）；
// 多站在 stops 数组中逐站填写名称、展示媒介、地区、起止日期，按数组顺序展出。
function readPackageBody(body) {
  const name = str(body.name).trim();
  if (!name) throw new HttpError(400, '展览包名称不能为空');
  const materialIds = [...new Set((body.materialIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

  const rawStops = Array.isArray(body.stops) ? body.stops : null;
  if (rawStops) {
    if (rawStops.length < 2) {
      throw new HttpError(400, '多站巡展至少需要 2 个站次；单站包请使用单站字段（medium/region/useFrom/useTo）',
        { code: 'INVALID_STOPS' });
    }
    const norm = normalizeStops(rawStops);
    const errors = [];
    if (norm.fatalError) errors.push(norm.fatalError);
    for (const s of norm.stops) errors.push(...s.errors);
    errors.push(...norm.orderErrors);
    if (errors.length) throw new HttpError(400, '多站行程校验失败：' + errors.join('；'), { code: 'INVALID_STOPS', errors });
    return {
      name,
      materialIds,
      isTour: true,
      stops: norm.stops.map((s) => ({
        position: s.position, name: s.name, medium: s.medium, region: s.region, useFrom: s.useFrom, useTo: s.useTo,
      })),
    };
  }

  const { medium, region } = validateScope(body);
  const useFrom = str(body.useFrom).trim();
  const useTo = str(body.useTo).trim();
  validateDateRange(useFrom, useTo);
  return { name, medium, region, useFrom, useTo, materialIds, isTour: false };
}

// 在事务内整体替换多站行程（多站行程仅待发布时可改）
function replaceStops(packageId, stops) {
  db.prepare('DELETE FROM package_stops WHERE package_id=?').run(packageId);
  const ins = db.prepare(
    'INSERT INTO package_stops(package_id, position, name, medium, region, use_from, use_to) VALUES (?,?,?,?,?,?,?)'
  );
  for (const s of stops) {
    ins.run(packageId, s.position, s.name, s.medium, s.region, s.useFrom, s.useTo);
  }
}

app.post('/api/packages', (req, res, next) => {
  try {
    const b = readPackageBody(req.body);
    for (const id of b.materialIds) loadMaterial(id);
    const info = tx(() => {
      const r = db.prepare('INSERT INTO packages(name, medium, region, use_from, use_to, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(
          b.name,
          b.isTour ? null : b.medium,
          b.isTour ? null : b.region,
          b.isTour ? null : b.useFrom,
          b.isTour ? null : b.useTo,
          'draft', nowIso(), nowIso()
        );
      const pid = r.lastInsertRowid;
      b.materialIds.forEach((mid, i) => {
        db.prepare('INSERT INTO package_items(package_id, material_id, position) VALUES (?,?,?)').run(pid, mid, i);
      });
      if (b.isTour) replaceStops(pid, b.stops);
      return pid;
    });
    res.status(201).json(packageDTO(db.prepare('SELECT * FROM packages WHERE id=?').get(info), true));
  } catch (e) { next(e); }
});

app.patch('/api/packages/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
    if (!pkg) throw new HttpError(404, '展览包不存在');
    if (pkg.status !== 'draft') {
      throw new HttpError(409, `已发布/需复核包（状态 ${pkg.status}）的参数与清单不可修改；如需调整请复制为新的待发布包`);
    }
    const b = readPackageBody(req.body);
    for (const mid of b.materialIds) loadMaterial(mid);
    tx(() => {
      db.prepare('UPDATE packages SET name=?, medium=?, region=?, use_from=?, use_to=?, updated_at=? WHERE id=?')
        .run(
          b.name,
          b.isTour ? null : b.medium,
          b.isTour ? null : b.region,
          b.isTour ? null : b.useFrom,
          b.isTour ? null : b.useTo,
          nowIso(), id
        );
      replaceStops(id, b.isTour ? b.stops : []);
      db.prepare('DELETE FROM package_items WHERE package_id=?').run(id);
      b.materialIds.forEach((mid, i) => {
        db.prepare('INSERT INTO package_items(package_id, material_id, position) VALUES (?,?,?)').run(id, mid, i);
      });
    });
    res.json(packageDTO(db.prepare('SELECT * FROM packages WHERE id=?').get(id), true));
  } catch (e) { next(e); }
});

app.post('/api/packages/:id/copy', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
    if (!pkg) throw new HttpError(404, '展览包不存在');
    const items = db.prepare('SELECT material_id, position FROM package_items WHERE package_id=? ORDER BY position').all(id);
    const stops = loadStops(db, id);
    const newId = tx(() => {
      const r = db.prepare('INSERT INTO packages(name, medium, region, use_from, use_to, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(`${pkg.name}（副本）`, pkg.medium, pkg.region, pkg.use_from, pkg.use_to, 'draft', nowIso(), nowIso());
      items.forEach((it) => {
        db.prepare('INSERT OR IGNORE INTO package_items(package_id, material_id, position) VALUES (?,?,?)')
          .run(r.lastInsertRowid, it.material_id, it.position);
      });
      if (stops.length) {
        const ins = db.prepare(
          'INSERT INTO package_stops(package_id, position, name, medium, region, use_from, use_to) VALUES (?,?,?,?,?,?,?)'
        );
        for (const s of stops) {
          ins.run(r.lastInsertRowid, s.position, s.name, s.medium, s.region, s.useFrom, s.useTo);
        }
      }
      return r.lastInsertRowid;
    });
    res.status(201).json(packageDTO(db.prepare('SELECT * FROM packages WHERE id=?').get(newId), true));
  } catch (e) { next(e); }
});

app.delete('/api/packages/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
    if (!pkg) throw new HttpError(404, '展览包不存在');
    if (pkg.status !== 'draft') throw new HttpError(409, '已发布或需复核的包带有不可变快照，不可删除');
    db.prepare('DELETE FROM packages WHERE id=?').run(id);
    res.status(204).end();
  } catch (e) { next(e); }
});

// ---------- 核验（待发布/重新核验） ----------
app.post('/api/verify', (req, res, next) => {
  try {
    let materialIds;
    let stops = null;
    if (req.body.packageId) {
      const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(Number(req.body.packageId));
      if (!pkg) throw new HttpError(404, '展览包不存在');
      materialIds = db.prepare('SELECT material_id FROM package_items WHERE package_id=?').all(pkg.id).map((r) => r.material_id);
      const storedStops = loadStops(db, pkg.id);
      if (storedStops.length) {
        stops = storedStops;
      } else {
        req.body = { ...req.body, medium: pkg.medium, region: pkg.region, useFrom: pkg.use_from, useTo: pkg.use_to };
      }
    } else {
      materialIds = req.body.materialIds || [];
      if (Array.isArray(req.body.stops)) {
        // 多站试核验：行程结构非法直接 400（与保存接口一致），核验结果仅在结果对象里反映授权类问题
        const norm = normalizeStops(req.body.stops);
        const errors = [];
        if (norm.fatalError) errors.push(norm.fatalError);
        if (!norm.fatalError && norm.stops.length < 2) errors.push('多站巡展至少需要 2 个站次');
        for (const s of norm.stops) errors.push(...s.errors);
        errors.push(...norm.orderErrors);
        if (errors.length) {
          throw new HttpError(400, '多站行程校验失败：' + errors.join('；'), { code: 'INVALID_STOPS', errors });
        }
        stops = norm.stops;
      }
    }
    const result = stops
      ? verifyTourPackage(db, { materialIds, stops })
      : verifyPackage(db, {
        materialIds,
        medium: req.body.medium,
        region: req.body.region,
        useFrom: req.body.useFrom,
        useTo: req.body.useTo,
      });
    res.json(result);
  } catch (e) { next(e); }
});

// ---------- 发布：原子保存不可变快照 + 冻结清单 ----------
app.post('/api/packages/:id/publish', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (req.body.basisVersion === undefined) throw new HttpError(400, '缺少核验依据版本 basisVersion');
    const clientBasis = Number(req.body.basisVersion);

    // 事务 A：读取 + 依据版本校验 + 按当前数据重算（单线程写，无并发插入窗口）
    const decision = tx(() => {
      const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
      if (!pkg) throw new HttpError(404, '展览包不存在');
      if (pkg.status !== 'draft') throw new HttpError(409, `当前状态为 ${pkg.status}，只有待发布包可以发布`);

      const currentBasis = db.prepare("SELECT CAST(value AS INTEGER) FROM meta WHERE key='basis_version'").pluck().get();
      if (clientBasis !== currentBasis) {
        throw new HttpError(409,
          `核验依据已过期：核验时版本 ${clientBasis}，当前版本 ${currentBasis}，授权或来源关系在此期间被修改。请重新核验后再发布。`,
          { code: 'STALE_BASIS', clientBasis, currentBasis });
      }

      const items = db
        .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
        .all(id)
        .map((r) => r.material_id);
      // 同一事务内重读行程（多站）、清单与全部授权依据后重算：任一站失败则整包不合格
      const result = verifyStoredPackage(db, pkg, items);
      return { eligible: result.eligible, result };
    });

    if (!decision.eligible) {
      // 不合格：独立事务留存不可变的发布尝试记录，包状态不变（仍为 draft）
      const snapId = tx(() => db.prepare(
        `INSERT INTO verification_snapshots(package_id, kind, basis_version, eligible, payload, created_at)
         VALUES (?,?,?,?,?,?)`
      ).run(id, 'publish', decision.result.basisVersion, 0, JSON.stringify(decision.result), nowIso()).lastInsertRowid);
      throw new HttpError(422, '核验未通过，拒绝发布：缺少授权或日期不合法。请按核验结果修正后重试。',
        { result: decision.result, snapshotId: snapId });
    }

    // 合格：事务 B 原子提交不可变快照 + published 状态（清单随发布不可再改）
    const snapshotId = tx(() => {
      const currentBasis = db.prepare("SELECT CAST(value AS INTEGER) FROM meta WHERE key='basis_version'").pluck().get();
      if (clientBasis !== currentBasis) {
        throw new HttpError(409,
          `核验依据已过期：核验时版本 ${clientBasis}，当前版本 ${currentBasis}，授权或来源关系在此期间被修改。请重新核验后再发布。`,
          { code: 'STALE_BASIS', clientBasis, currentBasis });
      }
      const snap = db.prepare(
        `INSERT INTO verification_snapshots(package_id, kind, basis_version, eligible, payload, created_at)
         VALUES (?,?,?,?,?,?)`
      ).run(id, 'publish', decision.result.basisVersion, 1, JSON.stringify(decision.result), nowIso());
      db.prepare("UPDATE packages SET status='published', published_at=?, updated_at=? WHERE id=?")
        .run(nowIso(), nowIso(), id);
      return snap.lastInsertRowid;
    });

    res.status(201).json({
      ok: true,
      message: '发布成功：核验快照与素材清单已原子保存（不可变）',
      snapshotId,
      package: packageDTO(db.prepare('SELECT * FROM packages WHERE id=?').get(id), true),
      result: decision.result,
    });
  } catch (e) { next(e); }
});

// ---------- 手动复核已标记包：重新核验，合格则恢复发布 ----------
app.post('/api/packages/:id/recheck', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const output = tx(() => {
      const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
      if (!pkg) throw new HttpError(404, '展览包不存在');
      if (pkg.status === 'draft') throw new HttpError(409, '待发布包请直接使用核验/发布功能');

      const items = db
        .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
        .all(id)
        .map((r) => r.material_id);
      // 多站包人工复核须全站合格才恢复；单站包沿用原规则
      const result = verifyStoredPackage(db, pkg, items);
      const snapRes = db.prepare(
        `INSERT INTO verification_snapshots(package_id, kind, basis_version, eligible, payload, created_at)
         VALUES (?,?,?,?,?,?)`
      ).run(id, 'recheck', result.basisVersion, result.eligible ? 1 : 0, JSON.stringify(result), nowIso());

      let status = pkg.status;
      if (result.eligible) {
        status = 'published';
        db.prepare("UPDATE packages SET status='published', updated_at=? WHERE id=?").run(nowIso(), id);
      }
      return { snapshotId: snapRes.lastInsertRowid, result, status };
    });
    res.json({
      ok: true,
      status: output.status,
      restored: output.status === 'published',
      message: output.result.eligible
        ? '复核通过，包已恢复为已发布（原快照保留未改动）'
        : '复核后仍不合格，包保持需复核状态（原快照保留未改动）',
      snapshotId: output.snapshotId,
      result: output.result,
      package: packageDTO(db.prepare('SELECT * FROM packages WHERE id=?').get(id), true),
    });
  } catch (e) { next(e); }
});

// ---------- 档期规划：搜索可用起始日 / 选定并应用到待发布包 ----------
app.post('/api/packages/:id/schedule/search', (req, res, next) => {
  try {
    const result = searchSchedule(db, { ...(req.body || {}), packageId: Number(req.params.id) });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

app.post('/api/packages/:id/schedule/apply', (req, res, next) => {
  try {
    const out = applySchedule(db, {
      ...(req.body || {}),
      packageId: Number(req.params.id),
    });
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(out.packageId);
    res.json({
      ok: true,
      message: `档期已更新：${out.useFrom} → ${out.useTo}（展期 ${out.durationDays} 天，含首尾）。`,
      useFrom: out.useFrom,
      useTo: out.useTo,
      durationDays: out.durationDays,
      basisVersion: out.basisVersion,
      package: packageDTO(pkg, true),
    });
  } catch (e) { next(e); }
});

// ---------- 变更影响预演 / 确认提交（馆员对单笔授权或单条来源关系先预演再确认） ----------
// 请求字段沿用对应既有编辑接口；预演只读不落库，确认在事务内核版本、重算并比对影响清单。
app.post('/api/changes/preview', (req, res, next) => {
  try {
    const result = previewChange(db, req.body || {});
    res.json({
      ok: true,
      phase: 'preview',
      message: result.impact.length
        ? `预演完成：该变更将使 ${result.impact.length} 个已发布展览包由合格转为不合格（需复核）。预演未改动任何数据。`
        : '预演完成：该变更不会使任何已发布展览包转为不合格。预演未改动任何数据。',
      ...result,
    });
  } catch (e) { next(e); }
});

app.post('/api/changes/commit', (req, res, next) => {
  try {
    const result = commitChange(db, req.body || {});
    res.json({
      ok: true,
      phase: 'commit',
      message: result.impact.length
        ? `变更已执行：${result.impact.length} 个已发布包被标记为需复核并已追加不可变复核快照；需复核包不会自动恢复。`
        : '变更已执行：无已发布包受影响，未产生需复核标记。',
      ...result,
    });
  } catch (e) { next(e); }
});

// ---------- 快照 ----------
app.get('/api/snapshots/:id', (req, res, next) => {
  try {
    const s = db.prepare('SELECT * FROM verification_snapshots WHERE id=?').get(Number(req.params.id));
    if (!s) throw new HttpError(404, '快照不存在');
    res.json({
      id: s.id,
      packageId: s.package_id,
      kind: s.kind,
      basisVersion: s.basis_version,
      eligible: !!s.eligible,
      createdAt: s.created_at,
      immutable: true,
      payload: JSON.parse(s.payload),
    });
  } catch (e) { next(e); }
});

// ---------- 错误处理 ----------
app.use((err, req, res, next) => {
  if (err instanceof HttpError || err instanceof ChangeError || err instanceof ScheduleError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err && err.code === 'SQLITE_CONSTRAINT_TRIGGER') {
    return res.status(409).json({ error: '数据库约束拒绝：' + err.message });
  }
  console.error(err);
  res.status(500).json({ error: '服务器内部错误：' + (err.message || err) });
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`数字展品授权核验应用已启动: http://localhost:${PORT}`);
});
