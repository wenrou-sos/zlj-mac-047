const BASE = process.env.API_BASE || 'http://localhost:3001/api';
let failures = 0;
let currentExpected = 200;
const assert = (cond, msg) => {
  if (!cond) { failures++; console.error('FAIL:', msg); }
  else console.log('PASS:', msg);
};
const req = async (path, opts = {}, expected = currentExpected) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  assert(res.status === expected, `${opts.method || 'GET'} ${path} -> ${res.status} (expected ${expected}) ${data.error || ''}`);
  if (!res.ok) throw Object.assign(new Error(data.error || res.status), { data, status: res.status });
  return data;
};

const unique = (p) => `${p}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100000)}`;
const locs = await req('/locations?includeVehicles=true');
const byCode = Object.fromEntries(locs.map((l) => [l.code, l]));
// 新建专用空库位，避免滚动盘点把模拟数据中的既有差异带入测试
const makeLoc = async (code) => req('/locations', { method: 'POST', body: {
  code, loc_type: 'storage', zone: '测试区', name: `${code} 测试库位`, capacity: 1000,
}}, 201);
const tLoc1 = await makeLoc(unique('T1-'));
const tLoc2 = await makeLoc(unique('T2-'));
const tLoc3 = await makeLoc(unique('T3-'));
const tLoc4 = await makeLoc(unique('T4-'));
const tHold = await makeLoc(unique('TH-'));
const vehicles = await req('/vehicles');
const activeVehicle = vehicles.find((v) => ['unloaded', 'sorting', 'sorted'].includes(v.status));
assert(activeVehicle, '存在可装车/发车的活动车辆');

// 1. 到件 -> 上架 -> 移位；同一件始终只有一个位置
const pkgA = await req('/packages', { method: 'POST', body: {
  tracking_no: unique('ST-A-'), destination: '上海', vehicle_id: activeVehicle.id,
}}, 201);
assert(pkgA.current_location_id === byCode['RECV-01'].id, '到件进入 RECV-01');
await req(`/packages/${pkgA.id}/sort`, { method: 'POST', body: { target_location_id: tLoc1.id } });
let a = await req(`/packages?q=${pkgA.tracking_no}`);
assert(a.items[0].location_code === tLoc1.code && a.items[0].status === 'sorted', '分拣后上架到测试库位1');
await req('/locations/move', { method: 'POST', body: { package_id: pkgA.id, target_location_id: tLoc2.id }});
a = await req(`/packages?q=${pkgA.tracking_no}`);
assert(a.items[0].location_code === tLoc2.code, '移位到测试库位2');

// 2. 盘点时点在库；随后装车发走，扫描结果必须核销为期间装车，不能判丢失
const st1 = await req('/stocktakes', { method: 'POST', body: { location_id: tLoc2.id }}, 201);
assert(st1.snapshot_summary.total >= 1, '测试库位2快照包含账存件');
await req(`/packages/${pkgA.id}/load`, { method: 'POST' });
const complete1 = await req(`/stocktakes/${st1.id}/complete`, { method: 'POST' });
const aDiff = complete1.differences.find((d) => d.tracking_no === pkgA.tracking_no);
assert(!aDiff, '盘点期间装车的件不产生盘亏/错位差异');
const aSnap = complete1.snapshot_summary;
assert(aSnap.shipped >= 1, `期间装车被流水核销（shipped=${aSnap.shipped}）`);
const adjusted1 = await req(`/stocktakes/${st1.id}/adjust`, { method: 'POST' });
assert(adjusted1.status === 'adjusted', '无待复核差异时可直接完成调账');
a = await req(`/packages?q=${pkgA.tracking_no}`);
assert(a.items[0].status === 'loaded', '已发运件状态仍为 loaded，未误判盘亏');

// 3. 盘点期间新到件并移入盘点库位：属于期间移入，不算盘盈
const st2 = await req('/stocktakes', { method: 'POST', body: { location_id: tLoc3.id }}, 201);
const pkgB = await req('/packages', { method: 'POST', body: { tracking_no: unique('ST-B-'), destination: '北京' }}, 201);
await req(`/packages/${pkgB.id}/sort`, { method: 'POST', body: { target_location_id: tLoc3.id } });
const scanB = await req(`/stocktakes/${st2.id}/scan`, { method: 'POST', body: {
  tracking_no: pkgB.tracking_no, observed_location_id: tLoc3.id,
}}, 201);
assert(scanB.recent_scans[0].result === 'period_in', '盘点期间移入/到件标记 period_in');
assert(!scanB.differences.some((d) => d.tracking_no === pkgB.tracking_no), '期间移入件不判盘盈');

// 4. 未知运单号 = 盘盈，必须复核确认后才补账
const surplusNo = unique('ST-SURPLUS-');
const scanS = await req(`/stocktakes/${st2.id}/scan`, { method: 'POST', body: {
  tracking_no: surplusNo, observed_location_id: tLoc3.id, destination: '深圳',
}}, 201);
const surplusDiff = scanS.differences.find((d) => d.tracking_no === surplusNo && d.diff_type === 'surplus');
assert(surplusDiff, '系统不存在的实盘件形成盘盈差异');
const complete2 = await req(`/stocktakes/${st2.id}/complete`, { method: 'POST' });
await expect409(() => req(`/stocktakes/${st2.id}/adjust`, { method: 'POST' }), '存在未复核差异时禁止调账');
const reviewed2 = await req(`/stocktakes/${st2.id}/differences/${surplusDiff.id}/review`, {
  method: 'PUT', body: { decision: 'confirmed', note: '现场补录' },
});
assert(reviewed2.differences.find((d) => d.id === surplusDiff.id).resolution === 'confirmed', '盘盈差异复核确认');
const adjusted2 = await req(`/stocktakes/${st2.id}/adjust`, { method: 'POST' });
assert(adjusted2.status === 'adjusted', '复核完成后允许调账');
const foundSurplus = await req(`/packages?q=${surplusNo}`);
assert(foundSurplus.items[0]?.current_location_id === tLoc3.id, '盘盈补账后落在实盘库位');

// 5. 真正盘亏：快照有、库里没有、也没有期间流转；复核后挂 LOST-01
const pkgC = await req('/packages', { method: 'POST', body: { tracking_no: unique('ST-C-'), destination: '广州' }}, 201);
await req(`/packages/${pkgC.id}/sort`, { method: 'POST', body: { target_location_id: tLoc4.id } });
const st3 = await req('/stocktakes', { method: 'POST', body: { location_id: tLoc4.id }}, 201);
// 模拟实物丢失：直接造一条离开流水但不更新包裹会造成账实不符；这里只结束盘点，由系统判 shortage
const complete3 = await req(`/stocktakes/${st3.id}/complete`, { method: 'POST' });
const shortDiff = complete3.differences.find((d) => d.tracking_no === pkgC.tracking_no && d.diff_type === 'shortage');
assert(shortDiff, '未盘到且无流水的件形成盘亏差异');
const reviewed3 = await req(`/stocktakes/${st3.id}/differences/${shortDiff.id}/review`, {
  method: 'PUT', body: { decision: 'confirmed', note: '确认找不到实物' },
});
await req(`/stocktakes/${st3.id}/adjust`, { method: 'POST' });
const lostPkg = await req(`/packages?q=${pkgC.tracking_no}`);
assert(lostPkg.items[0].status === 'lost' && lostPkg.items[0].location_code === 'LOST-01', '盘亏复核后状态 lost，位置 LOST-01');

// 6. 拦截只改处置状态，不改物理位置；拦截中禁止装车
const pkgD = await req('/packages', { method: 'POST', body: { tracking_no: unique('ST-D-'), destination: '杭州' }}, 201);
await req(`/packages/${pkgD.id}/sort`, { method: 'POST', body: { target_location_id: tHold.id } });
await req(`/packages/${pkgD.id}/intercept`, { method: 'POST', body: { abnormal_type: 'damaged', note: '包装破损' }});
let d = (await req(`/packages?q=${pkgD.tracking_no}`)).items[0];
assert(d.intercept_status === 'held' && d.status === 'sorted' && d.location_code === tHold.code, '拦截件保留 sorted 作业状态与原物理位置');
await expect409(() => req(`/packages/${pkgD.id}/load`, { method: 'POST' }), '拦截中禁止装车');
await req(`/packages/${pkgD.id}/release`, { method: 'POST' });
d = (await req(`/packages?q=${pkgD.tracking_no}`)).items[0];
assert(d.intercept_status === 'released' && d.status === 'sorted' && d.location_code === tHold.code, '解除拦截后位置/作业状态仍保持');

console.log(failures ? `\n${failures} 个断言失败` : '\n全部集成场景通过');
process.exit(failures ? 1 : 0);

async function expect409(fn, msg) {
  const oldExpected = currentExpected;
  currentExpected = 409;
  try {
    await fn();
    failures++;
    console.error('FAIL:', msg);
  } catch (e) {
    assert(e.status === 409, msg);
  } finally {
    currentExpected = oldExpected;
  }
}
