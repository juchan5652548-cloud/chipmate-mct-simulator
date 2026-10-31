const $ = (id) => document.getElementById(id);
const controls = ['speed', 'feed', 'depth', 'width'];
const materials = {
  aluminum: { name: '알루미늄 6061', kc: 700, optimalVc: 180, optimalFz: 0.08, color: 'AL 6061' },
  steel: { name: '탄소강 (S45C)', kc: 1800, optimalVc: 110, optimalFz: 0.06, color: 'S45C' },
  stainless: { name: '스테인리스 (SUS304)', kc: 2200, optimalVc: 85, optimalFz: 0.045, color: 'SUS304' }
};
let initialValues = { speed: 180, feed: 8, depth: 20, width: 40 };
let lastSnapshot = null;
let toastTimer;
let ncLinkState = null;

function currentSetup() {
  const material = materials[$('material').value];
  const diameter = Number($('tool').value);
  const teeth = Number($('toolTeeth')?.value) || (diameter === 12 ? 3 : 4);
  const operation = $('operation').value;
  const vc = Number($('speed').value);
  const fz = Number($('feed').value) / 100;
  const ap = Number($('depth').value) / 10;
  let ae = Number($('width').value) / 10;
  if (operation === 'slot') ae = diameter;
  const rpm = vc * 1000 / (Math.PI * diameter);
  const vf = fz * rpm * teeth;
  const mrr = ap * ae * vf / 1000;
  const power = ap * ae * vf * material.kc / 60000000;
  const torque = rpm > 0 ? power * 9549 / rpm : 0;
  const volume = 12000;
  const time = mrr > 0 ? volume / (mrr * 1000) : 0;
  return { material, diameter, teeth, operation, vc, fz, ap, ae, rpm, vf, mrr, power, torque, time };
}

function format(value, digits = 0) { return Number(value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits }); }

function coachText(s) {
  const rpmOver = s.rpm > 8000;
  const powerHigh = s.power > 5.5;
  const speedRatio = s.vc / s.material.optimalVc;
  const feedRatio = s.fz / s.material.optimalFz;
  const notes = [];
  if (rpmOver) notes.push(`회전수 ${format(s.rpm)} rpm이 장비 한계 8,000 rpm을 넘어요. 공구 지름이나 절삭속도를 낮춰 보세요.`);
  if (powerHigh) notes.push(`예상 주축 동력 ${format(s.power, 2)} kW가 장비 한계 5.5 kW를 넘어요. 절입량 또는 이송량을 줄이는 것이 안전합니다.`);
  if (!rpmOver && !powerHigh && (speedRatio > 1.3 || feedRatio > 1.5)) notes.push(`현재 조건은 ${s.material.name}의 학습용 기준보다 공격적이에요. 공구 마모와 진동 위험을 생각해 절삭속도 또는 날당 이송량을 조금 낮춰 비교해 보세요.`);
  if (!rpmOver && !powerHigh && speedRatio < .65) notes.push(`절삭속도가 학습용 기준보다 낮아요. 생산성이 떨어질 수 있지만, 소재와 공구 조건을 확인하며 조금씩 올려 비교할 수 있어요.`);
  if (!rpmOver && !powerHigh && feedRatio < .6) notes.push(`날당 이송량이 낮은 편이에요. 이송을 무조건 낮추기보다 공구사 권장조건과 최소 칩두께를 확인해 보세요.`);
  if (!notes.length) notes.push(`현재 조건은 장비 한계 안에 있고 ${s.material.name}의 기준 조건과도 가깝습니다. 절입량을 한 변수씩 조절해 가공시간과 동력 변화의 균형을 살펴보세요.`);
  const quality = Math.max(25, Math.round(100 - Math.abs(1 - speedRatio) * 24 - Math.abs(1 - feedRatio) * 23 - (powerHigh ? 25 : 0) - (rpmOver ? 20 : 0)));
  return { text: notes.join(' '), quality };
}

function update() {
  const s = currentSetup();
  document.querySelector('.stock-front span').textContent = s.material.color;
  const operationName = { side: '측면 밀링', face: '정면 밀링', slot: '슬롯 가공' }[s.operation];
  document.querySelector('.viz-topline span').innerHTML = `3축 수직 머시닝센터 <b>·</b> ${operationName}`;
  $('speedOut').innerHTML = `${format(s.vc)} <small>m/min</small>`;
  $('feedOut').innerHTML = `${format(s.fz, 2)} <small>mm/tooth</small>`;
  $('depthOut').innerHTML = `${format(s.ap, 1)} <small>mm</small>`;
  $('widthOut').innerHTML = `${format(s.ae, 1)} <small>mm</small>`;
  controls.forEach((id) => {
    const input = $(id);
    const pct = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
    input.style.setProperty('--fill', `${pct}%`);
  });
  $('rpmValue').innerHTML = `${format(s.rpm)} <small>rpm</small>`;
  $('feedValue').innerHTML = `${format(s.vf)} <small>mm/min</small>`;
  $('mrrValue').innerHTML = `${format(s.mrr, 1)} <small>cm³/min</small>`;
  $('powerValue').innerHTML = `${format(s.power, 2)} <small>kW</small>`;
  $('limitStatus').textContent = s.rpm > 8000 || s.power > 5.5 ? '▲ 한계 확인' : '● 정상 범위';
  $('limitStatus').classList.toggle('warning', s.rpm > 8000 || s.power > 5.5);
  const analysis = coachText(s);
  $('goalPercent').textContent = `${analysis.quality}%`;
  $('goalBar').style.width = `${analysis.quality}%`;
  if (lastSnapshot) {
    const delta = s.vf - lastSnapshot.vf;
    const movement = delta > 0 ? `테이블 이송속도가 ${format(Math.abs(delta))} mm/min 증가했어요.` : delta < 0 ? `테이블 이송속도가 ${format(Math.abs(delta))} mm/min 감소했어요.` : '테이블 이송속도는 변하지 않았어요.';
    $('coachMessage').innerHTML = `<div class="message-label">조건 변경 분석</div><p>${movement} ${analysis.text}</p>`;
  }
}

function clampControl(id, value) {
  const el = $(id), raw = Number(value);
  if (!Number.isFinite(raw)) return;
  el.value = String(Math.max(Number(el.min), Math.min(Number(el.max), raw)));
}

function showManualConditionMode() {
  ncLinkState = null;
  const panel = $('ncConditionLink');
  panel.dataset.mode = 'manual';
  $('ncLinkBadge').textContent = '수동 조건';
  $('ncLinkedCommand').textContent = '가공조건 슬라이더로 값을 설정 중입니다.';
  $('ncLinkedDetail').textContent = 'NC 코드를 분석하면 프로그램의 S/F/T와 절삭 결과가 이 미리보기에 연결됩니다.';
  $('previewSource').innerHTML = '<i></i> 수동 조건 계산';
  ['speed', 'feed', 'depth', 'width'].forEach(id => $(id).disabled = false);
  $('operation').disabled = false;
  $('recommendButton').disabled = false;
  const scene = $('machineScene');
  scene.classList.remove('running', 'nc-sim-linked');
  $('sceneMode').textContent = '대기 중';
  $('simulateButton').disabled = false;
  $('simulateButton').innerHTML = '<span>▶</span> 조건 시뮬레이션';
  update();
}

window.addEventListener('mct:nc-link', (event) => {
  const d = event.detail || {};
  if (d.phase === 'manual' || d.phase === 'edited') { showManualConditionMode(); return; }
  ncLinkState = d;
  const panel = $('ncConditionLink');
  panel.dataset.mode = d.phase === 'running' ? 'running' : d.phase === 'error' ? 'error' : 'linked';
  const phaseText = { ready: 'NC 코드 연결', running: 'NC 시뮬레이션 중', paused: 'NC 일시 정지', complete: 'NC 시뮬레이션 완료', error: 'NC 검증 중단' }[d.phase] || 'NC 코드 연결';
  $('ncLinkBadge').textContent = phaseText;
  $('operation').disabled = true;
  $('recommendButton').disabled = true;
  const rpm = Number(d.rpm) || 0, programmedFeed = Number(d.feed) || 0;
  const vc = Number(d.vc) || 0, fz = Number(d.fz) || 0, cutDepth = Number(d.cutDepth) || 0;
  if (d.diameter) {
    $('toolDiameter').value = d.diameter;
    let option = [...$('tool').options].find(o => Number(o.value) === Number(d.diameter));
    if (!option) { option = new Option(`NC 공구 · Ø${d.diameter} mm · ${d.teeth || 4}날`, String(d.diameter)); $('tool').add(option); }
    $('tool').value = option.value;
  }
  if (d.teeth) $('toolTeeth').value = d.teeth;
  if (vc > 0) clampControl('speed', Math.round(vc));
  if (fz > 0) clampControl('feed', Math.round(fz * 100));
  if (cutDepth > 0) clampControl('depth', Math.round(cutDepth * 10));
  ['speed', 'feed', 'depth', 'width'].forEach(id => $(id).disabled = true);
  update();
  if (vc > 0) $('speedOut').innerHTML = `${format(vc)} <small>m/min · NC S${format(rpm)} rpm</small>`;
  if (fz > 0) $('feedOut').innerHTML = `${format(fz, 3)} <small>mm/tooth · NC F${format(programmedFeed)} mm/min</small>`;
  if (cutDepth > 0) $('depthOut').innerHTML = `${format(cutDepth, 2)} <small>mm · NC 최대 Z 깊이</small>`;
  $('widthOut').innerHTML = '<small>NC 공구 경로 스윕 형상에서 계산</small>';
  $('rpmValue').innerHTML = `${format(rpm)} <small>rpm · G코드 S</small>`;
  $('feedValue').innerHTML = `${format(programmedFeed)} <small>mm/min · G코드 F</small>`;
  const mrr = Number(d.mrr) || 0;
  const kc = currentSetup().material.kc;
  const ncPower = mrr * kc / 60000;
  $('mrrValue').innerHTML = `${format(mrr, 2)} <small>cm³/min · NC 제거량/시간</small>`;
  $('powerValue').innerHTML = `${format(ncPower, 2)} <small>kW · 소재별 근사</small>`;
  const maxRpm = Number($('maxRpm')?.value) || 8000;
  $('limitStatus').textContent = rpm > maxRpm || ncPower > 5.5 ? '▲ 한계 확인' : '● 정상 범위';
  $('limitStatus').classList.toggle('warning', rpm > maxRpm || ncPower > 5.5);
  const toolText = d.toolNo ? `T${d.toolNo} · Ø${d.diameter} · ${d.teeth}날` : `공구 미지정 · Ø${d.diameter}`;
  $('ncLinkedCommand').textContent = d.code ? `N${d.lineNo || '—'}  ${d.code}` : 'NC 프로그램의 실제 공구 경로를 미리보기와 연결했습니다.';
  $('ncLinkedDetail').textContent = `${toolText} · S${format(rpm)} rpm · F${format(programmedFeed)} mm/min · Z깊이 ${format(cutDepth, 2)} mm · 제거 ${format(Number(d.removedVolume) || 0, 3)} cm³ · 누적 ${format(Number(d.elapsedSeconds) || 0, 1)}초 · ae는 공구경로 형상으로 계산${d.phase === 'ready' ? ' · 실행 전 계획 조건' : ''}`;
  $('previewSource').innerHTML = `<i></i> ${d.phase === 'ready' ? 'NC 코드 조건' : 'NC 시뮬레이션 결과'}`;
  if (d.phase === 'ready') {
    $('coachMessage').innerHTML = `<div class="message-label">NC 코드 연동</div><p>이 미리보기는 NC 프로그램의 <b>S${format(rpm)} rpm · F${format(programmedFeed)} mm/min · T${d.toolNo ?? '—'}</b> 조건을 읽었습니다. <b>NC 코드 실행</b>을 누르면 실제 공구 경로의 제거 체적과 재료 제거율이 갱신됩니다.</p>`;
  } else if (d.phase === 'complete') {
    const caution = d.warnings?.length ? ` 검토 경고가 ${d.warnings.length}건 있어 NC 화면의 경고를 확인하세요.` : ' NC 화면에서 블록별 충돌 검사 결과를 확인하세요.';
    $('coachMessage').innerHTML = `<div class="message-label">NC 가공 결과</div><p>실행한 경로의 소재 제거량은 <b>${format(Number(d.removedVolume) || 0, 3)} cm³</b>, 절삭 이송 중 평균 재료 제거율은 <b>${format(mrr, 2)} cm³/min</b>입니다.${caution}</p>`;
  } else if (d.phase === 'error') {
    $('coachMessage').innerHTML = `<div class="message-label">NC 검증 중단</div><p>해석할 수 없는 블록에서 시뮬레이션을 멈췄습니다. NC 시뮬레이터의 오류와 지원하지 않는 코드를 먼저 수정하세요.</p>`;
  } else if (d.phase === 'running' || d.phase === 'paused') {
    $('coachMessage').innerHTML = `<div class="message-label">NC 블록 실행 · N${d.lineNo || '—'}</div><p><b>S${format(rpm)} rpm · F${format(programmedFeed)} mm/min</b> 조건을 읽었습니다. 지금까지 소재 ${format(Number(d.removedVolume) || 0, 3)} cm³를 제거했고, 시뮬레이터가 공구·바이스 간섭을 확인하고 있습니다.</p>`;
  }
  const scene = $('machineScene');
  scene.classList.toggle('running', d.phase === 'running');
  scene.classList.add('nc-sim-linked');
  $('sceneMode').textContent = d.phase === 'running' ? `NC N${d.lineNo || '—'} 실행` : d.phase === 'paused' ? 'NC 일시 정지' : d.phase === 'complete' ? 'NC 완료' : d.phase === 'error' ? '코드 확인' : 'NC 경로 대기';
  const stockVolume = (Number($('stockX').value) || 60) * (Number($('stockY').value) || 40) * (Number($('stockZ').value) || 20) / 1000;
  const fraction = stockVolume > 0 ? Math.min((Number(d.removedVolume) || 0) / stockVolume, 1) : 0;
  $('stockCut').style.width = `${Math.max(20, Math.round(20 + fraction * 70))}%`;
  $('simulateButton').disabled = d.phase === 'error';
  $('simulateButton').innerHTML = d.phase === 'running' ? '<span>Ⅱ</span> NC 일시 정지' : d.phase === 'paused' ? '<span>▶</span> NC 계속 실행' : d.phase === 'complete' ? '<span>↻</span> NC 다시 실행' : d.phase === 'error' ? '<span>!</span> 코드 수정 필요' : '<span>▶</span> NC 코드 실행';
});

function setDialog(title, body) {
  $('dialogTitle').textContent = title;
  $('dialogBody').innerHTML = body;
  $('infoDialog').showModal();
}
function showToast(message) {
  const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

controls.forEach((id) => $(id).addEventListener('input', update));
['material', 'tool', 'operation'].forEach((id) => $(id).addEventListener('change', () => {
  if (id === 'material') {
    const preset = { aluminum: 180, steel: 110, stainless: 85 }[$(id).value];
    $('speed').value = Math.min(Number($('speed').value), preset);
  }
  if (id === 'tool') {
    $('toolDiameter').value = $('tool').value;
    $('toolTeeth').value = $('tool').value === '12' ? 3 : 4;
  }
  update();
  if (id === 'tool') $('toolDiameter').dispatchEvent(new Event('input', { bubbles: true }));
  if (ncLinkState && id === 'material') window.dispatchEvent(new CustomEvent('mct:nc-link', { detail: ncLinkState }));
}));

$('simulateButton').addEventListener('click', () => {
  if (ncLinkState) { $('runProgram').click(); return; }
  const scene = $('machineScene');
  if (scene.classList.contains('running')) return;
  lastSnapshot = currentSetup();
  scene.classList.add('running'); $('sceneMode').textContent = '가공 중';
  $('simulateButton').innerHTML = '<span>✓</span> 시뮬레이션 완료';
  $('simulateButton').disabled = true;
  const result = coachText(lastSnapshot);
  $('coachMessage').innerHTML = `<div class="message-label">실험 결과 분석</div><p><b>예상 가공시간 ${format(lastSnapshot.time, 1)}분</b>, 재료 제거율 ${format(lastSnapshot.mrr, 1)} cm³/min입니다. ${result.text}</p>`;
  showToast('가상 절삭 결과를 확인했어요. 조건을 바꿔 다시 비교해 보세요.');
  setTimeout(() => { scene.classList.remove('running'); $('sceneMode').textContent = '완료'; $('simulateButton').innerHTML = '<span>↻</span> 다시 시뮬레이션'; $('simulateButton').disabled = false; }, 1800);
});

$('hintButton').addEventListener('click', () => {
  const s = currentSetup();
  const fzEffect = s.fz * s.rpm * s.teeth;
  $('coachMessage').innerHTML = `<div class="message-label">단계별 힌트</div><p>힌트 1: 이송속도 공식은 <b>vf = fz × n × z</b>예요. 지금 조건에서 날당 이송량만 2배로 바꾸고, 회전수는 그대로 둔다면 이송속도는 <b>${format(fzEffect)} → ${format(fzEffect * 2)} mm/min</b>으로 바뀝니다. 직접 슬라이더로 확인해 보세요.</p>`;
});
$('recommendButton').addEventListener('click', () => {
  const presets = {
    aluminum: { speed: 180, feed: 8, depth: 20, width: 40 },
    steel: { speed: 110, feed: 6, depth: 15, width: 30 },
    stainless: { speed: 85, feed: 5, depth: 12, width: 25 }
  };
  Object.entries(presets[$('material').value]).forEach(([id, value]) => $(id).value = value);
  lastSnapshot = null;
  update();
  const s = currentSetup();
  $('coachMessage').innerHTML = `<div class="message-label">조건 추천 · ${s.material.name}</div><p>재질별 학습 기준값으로 조건을 설정했어요. <b>Vc ${format(s.vc)} m/min · fz ${format(s.fz, 2)} mm/tooth · ap ${format(s.ap, 1)} mm</b>입니다. 계산된 동력은 ${format(s.power, 2)} kW예요. 한 번에 한 변수씩 바꿔 추천 조건과 결과를 비교해 보세요.</p>`;
  showToast('재질별 학습 기준 조건을 적용했어요.');
});
$('explainButton').addEventListener('click', () => setDialog('가공조건 계산 공식', '<p>현재 설정값에 적용하는 기초 밀링 관계식입니다. 각 값의 단위를 확인하면서 조건이 결과에 미치는 영향을 살펴보세요.</p><ul class="dialog-list"><li><b>회전수 n</b> = 절삭속도 Vc × 1,000 ÷ (π × 공구지름 D)</li><li><b>이송속도 vf</b> = 날당 이송량 fz × 회전수 n × 날 수 z</li><li><b>재료 제거율 Q</b> = ap × ae × vf ÷ 1,000</li><li><b>주축 동력 Pc</b> ≈ ap × ae × vf × 비절삭저항 kc ÷ 60,000,000</li></ul><p>동력은 비절삭저항을 사용한 교육용 근사치이며 실제 절삭 상태와 기계 효율에 따라 달라집니다.</p>'));
$('resetButton').addEventListener('click', () => {
  $('material').value = 'aluminum'; $('tool').value = '10'; $('operation').value = 'side';
  Object.entries(initialValues).forEach(([id, value]) => $(id).value = value);
  lastSnapshot = null; $('machineScene').classList.remove('running'); $('sceneMode').textContent = '대기 중';
  $('coachMessage').innerHTML = '<div class="message-label">현재 조건 분석</div><p>알루미늄 6061에 적합한 조건으로 시작했어요. <b>날당 이송량</b>을 높이면 이송속도와 재료 제거율이 함께 증가합니다. 먼저 조건을 바꿔 결과를 비교해 볼까요?</p>';
  showManualConditionMode(); showToast('기본 조건으로 돌아왔어요.');
});
$('lessonButton').addEventListener('click', () => setDialog('오늘의 학습 목표', '<p>오늘은 가공조건 입력값과 결과 지표의 관계를 실험합니다.</p><ul class="dialog-list"><li>회전수와 절삭속도의 관계를 설명할 수 있다.</li><li>날당 이송량을 바꿨을 때 테이블 이송속도가 어떻게 변하는지 관찰한다.</li><li>절입량과 재료 제거율·주축 동력의 관계를 비교한다.</li></ul>'));
$('challengeButton').addEventListener('click', () => setDialog('미션 기준: 균형 잡힌 조건', '<p>12 cm³의 소재를 제거한다고 가정합니다. 조건을 조절해 아래 두 기준을 모두 만족해 보세요.</p><ul class="dialog-list"><li>예상 주축 동력: <b>5.5 kW 이하</b></li><li>장비 최대 회전수: <b>8,000 rpm 이하</b></li><li>미션 달성도는 소재별 학습 기준 조건과의 거리, 장비 한계 초과 여부로 계산합니다.</li></ul><p>달성도는 연습용 지표이며 실제 가공 품질을 보증하지 않습니다.</p>'));
$('formulaButton').addEventListener('click', () => setDialog('핵심 개념: 이송속도', '<p>밀링의 테이블 이송속도는 공구 날 하나가 한 회전 동안 전진하는 거리와 주축 회전수, 유효 날 수로 계산합니다.</p><div class="formula">vf = fz × n × z</div><ul class="dialog-list"><li><b>fz</b>: 날당 이송량 (mm/tooth)</li><li><b>n</b>: 주축 회전수 (rpm)</li><li><b>z</b>: 공구 날 수</li><li><b>vf</b>: 테이블 이송속도 (mm/min)</li></ul><p>슬라이더에서 날당 이송량만 바꾼 뒤 회전수와 이송속도를 비교해 보세요.</p>'));

update();
