'use strict';

// 多站巡展端到端业务规则测试（针对运行中的 http://localhost:3000）
const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  console.log('T1) 旧包兼容：既有单站包被视为单站（kind=single，stops 为空）');
  {
    const m = await call('POST', '/api/materials', { title: '巡测-成片', kind: 'video' });
    const pid = (await call('POST', '/api/packages', {
      name: '巡测-旧单站包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-01', useTo: '2026-03-31', materialIds: [m.data.id],
    })).data.id;
    const g = await call('GET', `/api/packages/${pid}`);
    ok(g.data.kind === 'single' && g.data.stopCount === 0 && Array.isArray(g.data.stops) && g.data.stops.length === 0,
      '不带 stops 创建的包是 single，stops 为空');
    ok(g.data.effectiveFrom === '2026-03-01' && g.data.effectiveTo === '2026-03-31', '单站展期即包展期');
    global.singlePid = pid; global.rootMat = m.data.id;
  }

  console.log('T2) 多站创建：每站字段校验、站间不得重叠（首尾均占用）');
  {
    const m1 = (await call('POST', '/api/materials', { title: '巡测-音乐', kind: 'audio' })).data.id;
    await call('POST', `/api/materials/${global.rootMat}/sources`, { sourceMaterialId: m1, relation: '配乐' });
    global.srcMat = m1;

    // 少于 2 站
    const one = await call('POST', '/api/packages', {
      name: '巡测-单站误交', stops: [{ name: 'A', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-10' }],
      materialIds: [global.rootMat],
    });
    ok(one.status === 400 && one.data.details.code === 'INVALID_STOPS', '仅 1 站被拒绝（多站至少 2 站）');

    // 缺字段
    const bad = await call('POST', '/api/packages', {
      name: '巡测-坏站', stops: [
        { name: 'A', media: '', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-10' },
        { name: 'B', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-20', useTo: '2026-03-10' },
      ], materialIds: [global.rootMat],
    });
    ok(bad.status === 400 && bad.data.details.code === 'INVALID_STOPS'
       && bad.data.details.errors.some((e) => e.includes('媒介'))
       && bad.data.details.errors.some((e) => e.includes('起止日期不合法')),
      '缺媒介、起止倒置逐站报 400');

    // 首尾相接（后站起 == 前站止）视为重叠
    const touch = await call('POST', '/api/packages', {
      name: '巡测-首尾相接', stops: [
        { name: 'A', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-10' },
        { name: 'B', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-10', useTo: '2026-03-20' },
      ], materialIds: [global.rootMat],
    });
    ok(touch.status === 400 && touch.data.error.includes('不得重叠'), '首尾日期相同（边界占用）按重叠拒绝');

    // 合法多站：两站不同地区
    const ok2 = await call('POST', '/api/packages', {
      name: '巡测-双城', stops: [
        { name: '北京站', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-15' },
        { name: '香港站', media: '屏幕放映', region: '中国香港', useFrom: '2026-04-01', useTo: '2026-04-20' },
      ], materialIds: [global.rootMat],
    });
    ok(ok2.status === 201 && ok2.data.kind === 'tour' && ok2.data.stopCount === 2, '合法两站包创建成功');
    ok(ok2.data.medium === null && ok2.data.useFrom === null, '多站包单站字段为空');
    ok(ok2.data.effectiveFrom === '2026-03-01' && ok2.data.effectiveTo === '2026-04-20',
      '整包展期取首站起 → 末站止');
    ok(ok2.data.stops.map((s) => s.position).join() === '1,2' && ok2.data.itemCount === 1,
      '站次按序保存，整包共享清单');
    global.tourPid = ok2.data.id;
  }

  console.log('T3) 多站核验：不同站可用不同授权；同站不可拼接短授权');
  {
    // root：中国大陆 03 月有整段授权；香港只有两段短授权（各不足整段）
    await call('POST', `/api/materials/${global.rootMat}/authorizations`, {
      media: '屏幕放映', region: '中国大陆', validFrom: '2026-03-01', validTo: '2026-03-31', licensor: 'CN',
    });
    await call('POST', `/api/materials/${global.rootMat}/authorizations`, {
      media: '屏幕放映', region: '中国香港', validFrom: '2026-04-01', validTo: '2026-04-10', licensor: 'HK1',
    });
    await call('POST', `/api/materials/${global.rootMat}/authorizations`, {
      media: '屏幕放映', region: '中国香港', validFrom: '2026-04-11', validTo: '2026-04-25', licensor: 'HK2',
    });
    // source（music）：*/* 覆盖全年
    await call('POST', `/api/materials/${global.srcMat}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2030-12-31', licensor: 'S',
    });

    const v = await call('POST', '/api/verify', { packageId: global.tourPid });
    ok(v.status === 200 && v.data.kind === 'tour' && v.data.eligible === false, '多站核验返回 tour 结果且整包不合格');
    ok(v.data.failingStops.length === 1 && v.data.failingStops[0].position === 2,
      '仅第 2 站（香港）失格，第 1 站合格');
    const hk = v.data.stops.find((s) => s.position === 2);
    const rootFail = hk.failingNodes.find((n) => n.materialId === global.rootMat);
    ok(!!rootFail && rootFail.reasons.includes('date'),
      '香港站 root 因无任何一份授权独自覆盖整段展期而失格（短授权不可拼接）');
    ok(rootFail.paths.some((p) => p.map((x) => x.materialId).join() === `${global.rootMat}`),
      '问题节点附全部来源路径（根路径）');
    const srcFail = hk.failingNodes.find((n) => n.materialId === global.srcMat);
    ok(!srcFail, 'source 节点 */* 授权两站均合格');
    const bj = v.data.stops.find((s) => s.position === 1);
    ok(bj.valid === true && bj.nodes.find((n) => n.materialId === global.rootMat).matchedAuthorization,
      '北京站 root 由单份大陆授权命中覆盖');
    // 顶层展平的 failingNodes 带站序号
    ok(v.data.failingNodes.every((n) => n.stopPosition === 2) && v.data.failingNodes.length === hk.failingNodes.length,
      '顶层问题节点列表按站展平并带 stopPosition/stopName');
  }

  console.log('T4) 任一站失败整包不发布（422，失败尝试留存快照，包仍 draft）');
  {
    const state = await call('GET', '/api/state');
    const pub = await call('POST', `/api/packages/${global.tourPid}/publish`, { basisVersion: state.data.basisVersion });
    ok(pub.status === 422 && pub.data.details.result.kind === 'tour', '多站包站失败发布被拒 422');
    ok(pub.data.details.snapshotId > 0, '失败发布尝试仍留存不可变快照');
    const g = await call('GET', `/api/packages/${global.tourPid}`);
    ok(g.data.status === 'draft' && g.data.snapshots.length === 1 && g.data.snapshots[0].eligible === false,
      '整包未发布，仅一条不合格发布尝试快照');
  }

  console.log('T5) 补正后两站合格 → 发布成功：冻结各站结果与清单（整包快照）');
  {
    // 给 root 增加一份覆盖香港整段的授权
    await call('POST', `/api/materials/${global.rootMat}/authorizations`, {
      media: '屏幕放映', region: '中国香港', validFrom: '2026-04-01', validTo: '2026-05-31', licensor: 'HK-FULL',
    });
    const v = await call('POST', '/api/verify', { packageId: global.tourPid });
    ok(v.data.eligible === true, '补授权后两站全部合格');
    const pub = await call('POST', `/api/packages/${global.tourPid}/publish`, { basisVersion: v.data.basisVersion });
    ok(pub.status === 201 && pub.data.package.status === 'published', '多站包发布成功');
    ok(pub.data.result.kind === 'tour' && pub.data.result.stops.length === 2 &&
       pub.data.result.stops.every((s) => s.valid),
      '发布快照冻结各站结果');
    global.pubSnapId = pub.data.snapshotId;
    const snap = await call('GET', `/api/snapshots/${pub.data.snapshotId}`);
    ok(snap.data.payload.kind === 'tour' &&
       snap.data.payload.request.materialIds.join() === `${global.rootMat}` &&
       snap.data.payload.request.stops.length === 2,
      '快照冻结整包清单与逐站结果');
    // 发布后不可改
    const patch = await call('PATCH', `/api/packages/${global.tourPid}`, {
      name: 'x', stops: [
        { name: 'A', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-15' },
        { name: 'B', media: '屏幕放映', region: '中国大陆', useFrom: '2026-04-01', useTo: '2026-04-20' },
      ], materialIds: [global.rootMat],
    });
    ok(patch.status === 409, '已发布多站包行程/清单不可改');
  }

  console.log('T6) 授权变更按站预演：仅因此失格的已发布多站包置需复核 + 追加快照');
  {
    const mats = await call('GET', '/api/materials');
    const hkFull = mats.data.find((x) => x.id === global.rootMat).authorizations
      .find((a) => a.region === '中国香港' && a.licensor === 'HK-FULL');
    const basis0 = (await call('GET', '/api/state')).data.basisVersion;
    const pv = await call('POST', '/api/changes/preview', { operation: 'authorization.revoke', authorizationId: hkFull.id });
    ok(pv.status === 200 && pv.data.mutated === false, '预演成功且不落库');
    const hit = pv.data.impact.find((p) => p.packageId === global.tourPid);
    ok(!!hit && hit.kind === 'tour', '预演影响含该已发布多站包');
    ok(hit.failingStops.map((s) => s.position).join() === '2', '受影响的是香港站（第 2 站）');
    ok(hit.failingNodes.every((n) => n.stopPosition === 2) &&
       hit.failingNodes.some((n) => n.materialId === global.rootMat && n.reasons.includes('date')),
      '按站列出问题节点、原因（短授权不拼接 → date）');
    // 原快照、状态在预演后不变
    const mid = await call('GET', `/api/packages/${global.tourPid}`);
    ok(mid.data.status === 'published' && mid.data.snapshots.length === 2 &&
       mid.data.snapshots.some((s) => s.id === global.pubSnapId), '预演不改状态/快照');

    const commit = await call('POST', '/api/changes/commit', {
      operation: 'authorization.revoke', authorizationId: hkFull.id,
      basisVersion: basis0, impact: pv.data.impact,
    });
    ok(commit.status === 200 && commit.data.mutated === true, '确认提交成功');
    const after = await call('GET', `/api/packages/${global.tourPid}`);
    ok(after.data.status === 'needs_review', '多站包被标记为需复核');
    // 此前含：失败发布尝试快照(T4) + 发布快照(T5)；确认后再追加一条 review
    ok(after.data.snapshots.some((s) => s.id === global.pubSnapId && s.kind === 'publish' && s.eligible === true) &&
       after.data.snapshots[after.data.snapshots.length - 1].kind === 'review' &&
       after.data.snapshots[after.data.snapshots.length - 1].eligible === false,
      '原发布快照保留，追加不合格 review 快照');
    global.hkAuthId = hkFull.id;
  }

  console.log('T7) 人工复核：任一站点不合格不恢复；全站合格才恢复（两种结果都追加快照）');
  {
    // 当前香港站仍只有两段短授权 → 复核不通过
    const rc1 = await call('POST', `/api/packages/${global.tourPid}/recheck`);
    ok(rc1.data.restored === false && rc1.data.package.status === 'needs_review', '香港站未补正：复核不恢复');
    const g1 = await call('GET', `/api/packages/${global.tourPid}`);
    ok(g1.data.snapshots[g1.data.snapshots.length - 1].kind === 'recheck' &&
       g1.data.snapshots[g1.data.snapshots.length - 1].eligible === false,
      '复核不通过也追加一条 recheck 快照');
    // 补一份覆盖香港整段的授权
    await call('POST', `/api/materials/${global.rootMat}/authorizations`, {
      media: '屏幕放映', region: '中国香港', validFrom: '2026-04-01', validTo: '2026-05-31', licensor: 'HK-FIX',
    });
    const rc2 = await call('POST', `/api/packages/${global.tourPid}/recheck`);
    ok(rc2.data.restored === true && rc2.data.package.status === 'published' && rc2.data.result.kind === 'tour',
      '全站合格后人工复核恢复为已发布');
    const beforeCount = g1.data.snapshots.length;
    const g2 = await call('GET', `/api/packages/${global.tourPid}`);
    ok(g2.data.snapshots.length === beforeCount + 1 && g2.data.snapshots[g2.data.snapshots.length - 1].eligible === true &&
       g2.data.snapshots.some((s) => s.id === global.pubSnapId),
      '复核通过再追加一条合格 recheck 快照（原快照全部保留）');
  }

  console.log('T8) 多站行程仅待发布时可改；改单/多形态、改站序均整包替换');
  {
    const pid = (await call('POST', '/api/packages', {
      name: '巡测-可编辑', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-01', useTo: '2026-03-31', materialIds: [global.rootMat],
    })).data.id;
    // 单站 → 多站
    const toTour = await call('PATCH', `/api/packages/${pid}`, {
      name: '巡测-可编辑', stops: [
        { name: '甲站', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-10' },
        { name: '乙站', media: '屏幕放映', region: '中国大陆', useFrom: '2026-04-01', useTo: '2026-04-10' },
      ], materialIds: [global.rootMat],
    });
    ok(toTour.status === 200 && toTour.data.kind === 'tour' && toTour.data.stopCount === 2 &&
       toTour.data.medium === null, '待发布包可由单站改为多站（整包替换）');
    // 多站 → 单站
    const toSingle = await call('PATCH', `/api/packages/${pid}`, {
      name: '巡测-可编辑', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-01', useTo: '2026-03-31', materialIds: [global.rootMat],
    });
    ok(toSingle.status === 200 && toSingle.data.kind === 'single' && toSingle.data.stopCount === 0
       && toSingle.data.useFrom === '2026-03-01', '待发布包可由多站改回单站，旧站次清空');
  }

  console.log('T9) 多站复制：副本为待发布且带完整行程与清单');
  {
    const copy = await call('POST', `/api/packages/${global.tourPid}/copy`);
    ok(copy.status === 201 && copy.data.kind === 'tour' && copy.data.status === 'draft' &&
       copy.data.stopCount === 2 && copy.data.itemCount === 1 &&
       copy.data.stops.map((s) => s.name).join() === '北京站,香港站',
      '复制多站包：副本待发布、行程与清单完整复制');
    global.copyPid = copy.data.id;
  }

  console.log('T10) 档期搜索/选定只适用单站：多站请求明确拒绝 409 MULTI_STOP');
  {
    const sr = await call('POST', `/api/packages/${global.copyPid}/schedule/search`, {
      planFrom: '2026-01-01', planTo: '2026-12-31',
    });
    ok(sr.status === 409 && sr.data.details.code === 'MULTI_STOP' && sr.data.details.stopCount === 2,
      '多站包搜索档期 409 MULTI_STOP');
    const ap = await call('POST', `/api/packages/${global.copyPid}/schedule/apply`, {
      useFrom: '2026-03-01', searchToken: { packageId: global.copyPid, basisVersion: 1, fingerprint: 'x', planFrom: '2026-01-01', planTo: '2026-12-31', durationDays: 10 },
    });
    ok(ap.status === 409 && ap.data.details.code === 'MULTI_STOP', '多站包选定档期同样 409 MULTI_STOP');
    // 单站包档期搜索不受影响
    const srSingle = await call('POST', `/api/packages/${global.singlePid}/schedule/search`, {
      planFrom: '2026-01-01', planTo: '2026-12-31',
    });
    ok(srSingle.status !== 409 || srSingle.data.details.code !== 'MULTI_STOP', '单站包不触发 MULTI_STOP');
  }

  console.log('T11) 多站试核验（不落库）：传 stops 数组');
  {
    const adhoc = await call('POST', '/api/verify', {
      materialIds: [global.rootMat, global.srcMat],
      stops: [
        { name: '上海', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-03-15' },
        { name: '纽约', media: '屏幕放映', region: '美国纽约', useFrom: '2026-05-01', useTo: '2026-05-15' },
      ],
    });
    ok(adhoc.status === 200 && adhoc.data.kind === 'tour' && adhoc.data.eligible === false,
      '临时多站试核验返回按站结果（纽约站无授权 → 不合格）');
    const ny = adhoc.data.stops.find((s) => s.region === '美国纽约');
    ok(ny.failingNodes.length >= 1 && ny.failingNodes.every((n) => n.reasons.includes('region') || n.reasons.includes('no_auth')),
      '纽约站节点因地区不覆盖失格并给出来源路径');
    const bad = await call('POST', '/api/verify', {
      materialIds: [global.rootMat],
      stops: [{ name: 'X', media: '屏幕放映', region: '中国大陆', useFrom: '2026-03-10', useTo: '2026-03-01' }],
    });
    ok(bad.status === 400, '非法多站试核验 400');
  }

  console.log('T12) 快照不可变触发器对多站快照同样生效');
  {
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH || '/workspace/data/app.db');
    let blocked = false;
    try { db.prepare('DELETE FROM verification_snapshots WHERE id=?').run(global.pubSnapId); }
    catch { blocked = true; }
    ok(blocked, '多站发布快照 DELETE 被触发器拒绝');
    db.close();
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
