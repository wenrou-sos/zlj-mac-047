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

// 7. 旧错位差异不得覆盖盘点期间的装车位置
const tLoc5 = await makeLoc(unique('T5-'));
const tLoc7B = await makeLoc(unique('T5B-'));
const pkgE = await req('/packages', { method: 'POST', body: {
  tracking_no: unique('ST-E-'), destination: '武汉', vehicle_id: activeVehicle.id,
}}, 201);
await req(`/packages/${pkgE.id}/sort`, { method: 'POST', body: { target_location_id: tLoc5.id } });
// A 库位盘点：实物其实在别处，结束得盘亏（先确认但暂不调账，包裹仍 sorted 在 tLoc5）
const st5 = await req('/stocktakes', { method: 'POST', body: { location_id: tLoc5.id }}, 201);
const done5a = await req(`/stocktakes/${st5.id}/complete`, { method: 'POST' });
const shortE = done5a.differences.find((x) => x.tracking_no === pkgE.tracking_no && x.diff_type === 'shortage');
assert(shortE, 'A 库位盘点生成盘亏差异');
// B 库位（空）盘点扫到该件：账面在 tLoc5、实物在 B，自然形成错位差异（无移位流水）
const st5b = await req('/stocktakes', { method: 'POST', body: { location_id: tLoc7B.id }}, 201);
const scanE = await req(`/stocktakes/${st5b.id}/scan`, { method: 'POST', body: {
  tracking_no: pkgE.tracking_no, observed_location_id: tLoc7B.id,
}}, 201);
const misE = scanE.differences.find((x) => x.tracking_no === pkgE.tracking_no && x.diff_type === 'misplaced');
assert(misE, 'B 库位跨库位扫描形成错位差异');
// 错位差异已产生，随后该件正常装车（位置变为车辆库位）
await req(`/packages/${pkgE.id}/load`, { method: 'POST' });
const loadedE = (await req(`/packages?q=${pkgE.tracking_no}`)).items[0];
assert(loadedE.status === 'loaded', '错位差异生成后该件已装车');
const done5b = await req(`/stocktakes/${st5b.id}/complete`, { method: 'POST' });
const misEDiff = done5b.differences.find((x) => x.id === misE.id);
assert(misEDiff, '错位差异保留到复核阶段');
await req(`/stocktakes/${st5b.id}/differences/${misE.id}/review`, {
  method: 'PUT', body: { decision: 'confirmed', note: '误以为错位' },
});
await expect409(() => req(`/stocktakes/${st5b.id}/adjust`, { method: 'POST' }),
  '错位差异调整被拒绝：不能把已装车件从车辆库位拉回');
const stillLoaded = (await req(`/packages?q=${pkgE.tracking_no}`)).items[0];
assert(stillLoaded.status === 'loaded' && stillLoaded.location_code === `VEH-${activeVehicle.id}`,
  '装车位置未被旧错位差异覆盖');

// 8. 跨库位盘点：A 判盘亏并调账(lost)，B 扫到实物判错位，错位调账受控恢复，不产生矛盾账
const tLoc6 = await makeLoc(unique('T6-'));
const tLoc7 = await makeLoc(unique('T7-'));
const pkgF = await req('/packages', { method: 'POST', body: { tracking_no: unique('ST-F-'), destination: '南京' }}, 201);
await req(`/packages/${pkgF.id}/sort`, { method: 'POST', body: { target_location_id: tLoc6.id } });
const st6 = await req('/stocktakes', { method: 'POST', body: { location_id: tLoc6.id }}, 201);
// 实物其实在 tLoc7：无流水的跨库位错位。结束 A 盘点得到盘亏
const done6 = await req(`/stocktakes/${st6.id}/complete`, { method: 'POST' });
const shortF = done6.differences.find((x) => x.tracking_no === pkgF.tracking_no && x.diff_type === 'shortage');
assert(shortF, 'A 库位盘点生成盘亏差异');
await req(`/stocktakes/${st6.id}/differences/${shortF.id}/review`, {
  method: 'PUT', body: { decision: 'confirmed', note: '确认没找到' },
});
await req(`/stocktakes/${st6.id}/adjust`, { method: 'POST' });
let f = (await req(`/packages?q=${pkgF.tracking_no}`)).items[0];
assert(f.status === 'lost' && f.location_code === 'LOST-01', 'A 库位盘亏调账后置 lost / LOST-01');
// B 库位盘点扫到实物，形成错位差异
const st7 = await req('/stocktakes', { method: 'POST', body: { location_id: tLoc7.id }}, 201);
const scanF = await req(`/stocktakes/${st7.id}/scan`, { method: 'POST', body: {
  tracking_no: pkgF.tracking_no, observed_location_id: tLoc7.id,
}}, 201);
const misF = scanF.differences.find((x) => x.tracking_no === pkgF.tracking_no && x.diff_type === 'misplaced');
assert(misF, 'B 库位扫到 lost 件形成错位差异');
const done7 = await req(`/stocktakes/${st7.id}/complete`, { method: 'POST' });
await req(`/stocktakes/${st7.id}/differences/${misF.id}/review`, {
  method: 'PUT', body: { decision: 'confirmed', note: '找回实物' },
});
await req(`/stocktakes/${st7.id}/adjust`, { method: 'POST' });
f = (await req(`/packages?q=${pkgF.tracking_no}`)).items[0];
assert(f.status === 'sorted' && f.current_location_id === tLoc7.id,
  '跨库位错位调账受控恢复：status 还原 sorted，位置落在实盘库位');

// 9. 另一库位扫码后“取消盘点”，不能让原库位免算盘亏（已取消扫描无效）
const tLoc8 = await makeLoc(unique('T8-'));
const tLoc9 = await makeLoc(unique('T9-'));
const pkgG = await req('/packages', { method: 'POST', body: { tracking_no: unique('ST-G-'), destination: '天津' }}, 201);
await req(`/packages/${pkgG.id}/sort`, { method: 'POST', body: { target_location_id: tLoc8.id } });
// 原库位 A 发起盘点（reviewing，盘亏差异待复核）
const st8 = await req('/stocktakes', { method: 'POST', body: { location_id: tLoc8.id }}, 201);
const done8 = await req(`/stocktakes/${st8.id}/complete`, { method: 'POST' });
const shortG = done8.differences.find((x) => x.tracking_no === pkgG.tracking_no && x.diff_type === 'shortage');
assert(shortG, 'A 库位生成待复核盘亏差异');
// 另一库位 B 盘点扫到该件（错位），随后取消 B
const st9 = await req('/stocktakes', { method: 'POST', body: { location_id: tLoc9.id }}, 201);
const scanG = await req(`/stocktakes/${st9.id}/scan`, { method: 'POST', body: {
  tracking_no: pkgG.tracking_no, observed_location_id: tLoc9.id,
}}, 201);
assert(scanG.differences.some((x) => x.tracking_no === pkgG.tracking_no && x.diff_type === 'misplaced'),
  'B 库位扫描形成错位线索');
await req(`/stocktakes/${st9.id}/cancel`, { method: 'POST' });
// A 复核并调账盘亏：取消的 B 扫描不得免算
await req(`/stocktakes/${st8.id}/differences/${shortG.id}/review`, {
  method: 'PUT', body: { decision: 'confirmed', note: '他单已取消，维持盘亏' },
});
await req(`/stocktakes/${st8.id}/adjust`, { method: 'POST' });
const gAfter = (await req(`/packages?q=${pkgG.tracking_no}`)).items[0];
assert(gAfter.status === 'lost' && gAfter.location_code === 'LOST-01',
  '他单取消后其扫描不被采信，原库位盘亏正常调账');

// 10. 另一库位仅在“盘点中”扫到（未定论），也不能让原库位免算盘亏
const tLoc10 = await makeLoc(unique('T10-'));
const tLoc11 = await makeLoc(unique('T11-'));
const pkgH = await req('/packages', { method: 'POST', body: { tracking_no: unique('ST-H-'), destination: '重庆' }}, 201);
await req(`/packages/${pkgH.id}/sort`, { method: 'POST', body: { target_location_id: tLoc10.id } });
const st10 = await req('/stocktakes', { method: 'POST', body: { location_id: tLoc10.id }}, 201);
// B 库位先发起盘点并扫到该件，停留在 counting（未定稿）
const st11 = await req('/stocktakes', { method: 'POST', body: { location_id: tLoc11.id }}, 201);
await req(`/stocktakes/${st11.id}/scan`, { method: 'POST', body: {
  tracking_no: pkgH.tracking_no, observed_location_id: tLoc11.id,
}}, 201);
// 原库位结束盘点：counting 的他单扫描不足以免算盘亏
const done10 = await req(`/stocktakes/${st10.id}/complete`, { method: 'POST' });
const shortH = done10.differences.find((x) => x.tracking_no === pkgH.tracking_no && x.diff_type === 'shortage');
assert(shortH, '他单仅盘点中（未定稿）时，原库位仍生成盘亏差异');
await req(`/stocktakes/${st10.id}/differences/${shortH.id}/review`, {
  method: 'PUT', body: { decision: 'confirmed', note: '他单未定稿，维持盘亏' },
});
await req(`/stocktakes/${st10.id}/adjust`, { method: 'POST' });
const hAfter = (await req(`/packages?q=${pkgH.tracking_no}`)).items[0];
assert(hAfter.status === 'lost' && hAfter.location_code === 'LOST-01',
  '未定稿扫描不被采信，原库位盘亏正常调账');

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
