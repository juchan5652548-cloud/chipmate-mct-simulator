(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (n, digits = 1) => Number(n || 0).toLocaleString('ko-KR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  let nc = null;
  let quizTarget = null;
  const lessonIds = ['condition', 'code', 'setup', 'diagnosis', 'process'];
  const progressKey = 'chipmate-learning-progress-v1';
  let progress = { completed: {}, verified: {} };
  try { progress = { ...progress, ...JSON.parse(localStorage.getItem(progressKey) || '{}') }; } catch { /* storage may be disabled */ }
  progress.completed ||= {};
  progress.verified ||= {};
  function updateProgress() {
    const count = lessonIds.filter(id => progress.completed[id]).length;
    const verified = lessonIds.filter(id => progress.verified[id]).length;
    $('moduleProgress').textContent = `완료 ${count} / ${lessonIds.length} · 확인 ${verified} / ${lessonIds.length}`;
    $('sideProgressCount').textContent = `${count} / ${lessonIds.length}`;
    $('sideProgressBar').style.width = `${count / lessonIds.length * 100}%`;
    $('reflectionProgress').textContent = count ? `완료 ${count} / ${lessonIds.length} · 정답 확인 ${verified} / ${lessonIds.length}` : '아직 완료한 활동이 없습니다.';
    document.querySelectorAll('#learningModules .module-card:not(.learning-status)').forEach((card, index) => {
      const id = lessonIds[index];
      let badge = card.querySelector('.lesson-completion');
      if (!badge) { badge = document.createElement('span'); badge.className = 'lesson-completion'; card.querySelector('.module-kicker')?.append(badge); }
      badge.textContent = progress.completed[id] ? '완료 ✓' : '미완료';
      badge.classList.toggle('done', !!progress.completed[id]);
    });
  }
  function markLessonDone(id, learned, question, options, answer) {
    progress.completed[id] = true;
    try { localStorage.setItem(progressKey, JSON.stringify(progress)); } catch { /* current session still works */ }
    const select = $('reflectionAnswer');
    select.innerHTML = `<option value="">답을 선택하세요</option>${options.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}`;
    select.disabled = false;
    select.dataset.answer = answer;
    $('checkReflection').disabled = false;
    $('reflectionLearned').textContent = learned;
    $('reflectionQuestion').textContent = question;
    $('reflectionFeedback').textContent = '답을 고르고 정답 확인을 눌러 학습을 마무리하세요.';
    updateProgress();
  }
  const codeNames = {
    G0: '급속 위치결정(절삭 이송이 아님)', G00: '급속 위치결정(절삭 이송이 아님)', G1: 'F 이송속도로 직선 절삭/이동', G01: 'F 이송속도로 직선 절삭/이동',
    G2: '시계 방향 원호 보간', G02: '시계 방향 원호 보간', G3: '반시계 방향 원호 보간', G03: '반시계 방향 원호 보간',
    G17: 'XY 평면 선택', G18: 'XZ 평면 선택', G19: 'YZ 평면 선택', G20: '인치 단위 선택', G21: '미터(mm) 단위 선택',
    G40: '공구 반경 보정 취소', G43: '공구 길이 보정 적용(H 번호 확인)', G49: '공구 길이 보정 취소', G54: '작업 좌표계 G54 선택',
    G90: '절대 좌표 지정', G91: '증분 좌표 지정', G94: '분당 이송 모드', G98: '고정 사이클 초기점 복귀', G99: '고정 사이클 R점 복귀',
    G73: '고속 펙 드릴 사이클', G81: '드릴 사이클', G82: '정지시간 포함 드릴 사이클', G83: '펙 드릴 사이클',
    M0: '프로그램 정지', M00: '프로그램 정지', M1: '선택 정지', M01: '선택 정지', M2: '프로그램 종료', M30: '프로그램 종료·리셋',
    M3: '주축 정회전', M03: '주축 정회전', M4: '주축 역회전', M04: '주축 역회전', M5: '주축 정지', M05: '주축 정지',
    M6: '공구 교환(T 번호 확인)', M06: '공구 교환(T 번호 확인)', M7: '미스트 냉각수', M8: '절삭유 켜기', M9: '냉각수 끄기'
  };
  function currentValues() {
    const diameter = Number($('toolDiameter')?.value || $('tool')?.value || 10);
    const teeth = Number($('toolTeeth')?.value || 4);
    const rpm = nc?.rpm || Number($('rpmValue')?.textContent.replace(/[^\d.]/g, '') || 0);
    const feed = nc?.feed || Number($('feedValue')?.textContent.replace(/[^\d.]/g, '') || 0);
    const fz = nc?.fz || (rpm * teeth ? feed / (rpm * teeth) : 0);
    const materialKc = { aluminum: 700, steel: 1800, stainless: 2200 }[$('material')?.value] || 700;
    const volume = nc?.removedVolume > 0 ? nc.removedVolume : Number($('planVolume')?.value || 12);
    const mrr = nc?.mrr || Number($('mrrValue')?.textContent.replace(/[^\d.]/g, '') || 0);
    const cutSeconds = nc?.cuttingSeconds || 0;
    return { diameter, teeth, rpm, feed, fz, materialKc, volume, mrr, cutSeconds, isNc: !!nc };
  }
  function conditionCompare() {
    const v = currentValues(), factor = Number($('feedFactor').value);
    if (!(v.feed > 0)) { $('conditionCompareResult').textContent = 'F값이 없습니다. NC 코드에 F를 지정하거나 가공조건 패널에서 이송을 설정하세요.'; return; }
    const oldTime = v.cutSeconds > 0 ? v.cutSeconds / 60 : (v.mrr > 0 ? v.volume / v.mrr : 0);
    const newTime = oldTime ? oldTime / factor : 0;
    const qualityChange = factor > 1 ? `높은 이송은 날당 칩 두께와 이송 자국을 키워 표면 거칠기·진동 위험을 높일 수 있습니다.` : factor < 1 ? `이송을 낮추면 이송 자국은 줄 수 있지만, 지나치게 낮으면 마찰·가공 경화나 생산성 저하가 생길 수 있습니다.` : '기준 조건입니다.';
    $('conditionCompareResult').innerHTML = `<b>${v.isNc ? 'NC 경로 기준' : '수동 조건 기준'}</b> · F ${fmt(v.feed, 0)} → ${fmt(v.feed * factor, 0)} mm/min<br>고정 경로의 추정 절삭시간 ${oldTime ? `${fmt(oldTime)} → ${fmt(newTime)} min` : '비교 불가 (절삭시간/경로 체적 없음)'} · 시간 변화 ${oldTime ? `${factor > 1 ? '−' : '+'}${fmt(Math.abs(1 - 1 / factor) * 100, 0)}%` : '—'}<br><span>${qualityChange}</span>`;
    markLessonDone('condition', '이송 F를 높이면 같은 경로의 예상 시간은 줄지만, 칩 두께·이송 자국이 커질 수 있습니다.', 'F를 1.6배로 올렸을 때 회전수 S는 자동으로 바뀌나요?', [['yes', '예, 함께 증가한다'], ['no', '아니요, 별도 명령이 없으면 그대로다']], 'no');
  }
  function parseLines() {
    const lines = $('gcodeInput').value.split(/\r?\n/);
    const rows = [];
    lines.forEach((raw, i) => {
      const clean = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim();
      if (!clean) return;
      const words = clean.match(/[A-Z][-+]?\d*\.?\d+/gi) || [];
      const codes = words.filter(w => /^[GM][-+]?\d/i.test(w)).map(w => w.toUpperCase());
      const explanations = codes.map(c => `${c}: ${codeNames[c] || '이 학습 해설표에 정의되지 않은 코드 (선택한 프로파일 문서 확인)'}`);
      const coordinates = words.filter(w => /^[XYZIJKRFPQS][-+]?\d/i.test(w)).join(' ');
      const alerts = [];
      if (/\bG0?0\b/i.test(clean) && /Z[-+]?\d/i.test(clean) && Number((clean.match(/Z([-+]?\d*\.?\d+)/i) || [])[1]) < 0) alerts.push('G0로 소재 안쪽 Z에 접근하는지 확인');
      if (/\bM0?6\b/i.test(clean) && !/\bT\d+/i.test(clean)) alerts.push('M6 앞의 T 공구 번호 확인');
      if (/\bG0?1\b/i.test(clean) && !/\bF\d/i.test(clean) && !lines.slice(0, i).join('\n').match(/\bF\d/i)) alerts.push('유효한 F 이송값이 아직 없음');
      if (/\bG4[023]\b/i.test(clean) && !/\bH\d+/i.test(clean)) alerts.push('H 길이 보정 번호 확인');
      rows.push({ line: i + 1, code: clean, explanations, coordinates, alerts });
    });
    return rows;
  }
  function decode() {
    const rows = parseLines();
    if (!rows.length) { $('codeLessonResult').textContent = '해석할 코드가 없습니다.'; return; }
    const rendered = rows.slice(0, 35).map(r => `<div class="decoded-line"><code>N${r.line} ${escapeHtml(r.code)}</code><span>${r.explanations.length ? r.explanations.map(escapeHtml).join(' · ') : '모달 상태·주소값을 포함해 블록을 확인하세요.'}${r.coordinates ? ` <i>좌표/주소: ${escapeHtml(r.coordinates)}</i>` : ''}${r.alerts.length ? `<strong>⚠ ${r.alerts.map(escapeHtml).join(' · ')}</strong>` : ''}</span></div>`).join('');
    const active = nc?.lineNo ? `<div class="current-block-note">NC 시뮬레이터 현재 블록: N${nc.lineNo} ${escapeHtml(nc.code || '')} · ${nc.phase === 'complete' ? '실행 완료' : nc.phase}</div>` : '';
    $('codeLessonResult').innerHTML = `${active}<div class="decoded-list">${rendered}</div>${rows.length > 35 ? `<small>처음 35개 블록 표시 (${rows.length}개 중)</small>` : ''}`;
  }
  function startQuiz() {
    const codes = parseLines().flatMap(r => (r.code.match(/\b[GM]\d+\b/gi) || []).map(c => c.toUpperCase()).filter(c => codeNames[c]));
    quizTarget = codes[Math.floor(Math.random() * codes.length)] || 'G1';
    $('codeQuizResult').hidden = false;
    const options = [...new Set([codeNames[quizTarget], '급속 위치결정(절삭 이송이 아님)', '주축 정회전', '프로그램 종료·리셋'])].sort(() => Math.random() - .5);
    $('codeQuizResult').innerHTML = `<b>${quizTarget}의 기능은 무엇일까요?</b><div>${options.map((o, i) => `<button class="quiz-option" data-answer="${i}">${escapeHtml(o)}</button>`).join('')}</div>`;
    $('codeQuizResult').querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => {
      const correct = options[i] === codeNames[quizTarget];
      $('codeQuizResult').querySelectorAll('button').forEach(x => x.disabled = true);
      $('codeQuizResult').insertAdjacentHTML('beforeend', `<p class="${correct ? 'good' : 'bad'}">${correct ? '정답입니다.' : '다시 살펴보세요.'} ${quizTarget}는 ${escapeHtml(codeNames[quizTarget])}. 실제 동작은 선택된 제어기 프로파일에서 확인해야 합니다.</p>`);
      if (correct) markLessonDone('code', 'NC 한 블록의 G/M 명령과 좌표·이송 주소를 공구 동작에 연결했습니다.', `현재 퀴즈의 ${quizTarget} 기능은 무엇인가요?`, [[codeNames[quizTarget], codeNames[quizTarget]], ['other', '다른 기능']], codeNames[quizTarget]);
    }));
  }
  function setupFeedback() {
    const checks = [...document.querySelectorAll('.setup-checklist input')];
    const done = checks.filter(x => x.checked).length;
    const notes = [];
    if (!checks[0].checked) notes.push('바이스 간섭·소재 돌출');
    if (!checks[1].checked) notes.push(`T${nc?.toolNo ?? '공구'}·공구 길이`);
    if (!checks[2].checked) notes.push(`G${nc?.workSystem ?? 54} 원점·G43 H`);
    if (!checks[3].checked) notes.push('공중 운전·단일 블록');
    $('setupFeedback').innerHTML = done === checks.length ? '<b>준비 완료 체크</b> · 설정값과 프로그램의 공구/좌표계를 대조하고 첫 블록을 저속으로 확인하세요.' : `<b>${done}/${checks.length} 항목 확인</b> · ${notes.length ? `남은 확인: ${notes.join(', ')}` : '항목을 확인하세요.'}`;
    if (done === checks.length) markLessonDone('setup', '소재 체결, 공구, G54/G43, 공중 운전 확인이 가공 전 셋업의 기본 순서입니다.', '코드 실행 전 간섭과 경로를 먼저 확인할 때 적절한 방법은?', [['dry', '공중 운전·단일 블록으로 확인'], ['full', '바로 전체 자동 운전']], 'dry');
  }
  const cases = [
    { title: '가공 흔적 진단', clue: '측벽에 주기적인 물결 자국이 있고 절삭 중 떨림 소리가 들립니다. 우선 의심할 원인은?', answer: 'vibration', reason: '주기적 물결과 떨림은 공구·공작물 강성 부족이나 돌출 과다에 따른 채터링 단서입니다. 돌출·체결을 점검하고 조건을 보수적으로 조정하세요.' },
    { title: '치수 오차 진단', clue: '공구 경로는 정상인데 모든 형상의 위치가 같은 방향으로 어긋났습니다. 우선 확인할 것은?', answer: 'offset', reason: '전체 형상이 일정 방향으로 이동하면 G54 등 작업 좌표계 원점·측정 기준을 먼저 확인합니다.' },
    { title: '표면 거칠기 진단', clue: '벽면 이송 자국이 커지고 버가 늘었습니다. 다른 조건은 유지한 채 F를 크게 올렸습니다. 우선 의심할 것은?', answer: 'feed', reason: 'F 증가로 날당 이송량이 커지면 이송 자국과 절삭 부하가 증가할 수 있습니다. fz와 공구사 권장범위를 확인하세요.' }
  ];
  let caseIndex = 0;
  function showCase() { const c = cases[caseIndex]; $('defectTitle').textContent = c.title; $('defectClue').textContent = c.clue; $('defectChoice').value = ''; $('diagnosisResult').textContent = '조건을 고르고 진단을 확인하세요.'; }
  function diagnose() { const c = cases[caseIndex]; const chosen = $('defectChoice').value; if (!chosen) { $('diagnosisResult').textContent = '먼저 원인을 선택하세요.'; return; } $('diagnosisResult').innerHTML = `<b>${chosen === c.answer ? '진단 적중' : '다른 가능성도 검토해 보세요'}</b> · ${c.reason}`; if (chosen === c.answer) markLessonDone('diagnosis', '가공 흔적과 조건 변화를 연결해 불량 원인의 우선순위를 좁혔습니다.', '주기적인 물결 자국과 떨림이 함께 보일 때 먼저 점검할 것은?', [['stiffness', '공구 돌출과 체결 강성'], ['offset', 'G54 원점만 조정']], 'stiffness'); }
  function comparePlans() {
    const v = currentValues();
    const volume = nc?.removedVolume > 0 ? nc.removedVolume : Number($('planVolume').value || 12);
    const mrr = v.mrr;
    if (!(mrr > 0)) { $('processCompareResult').textContent = '비교 가능한 절삭 MRR이 없습니다. 유효한 F와 절삭 경로를 포함한 코드를 분석·실행하세요.'; return; }
    const onePass = volume / mrr;
    const twoPass = volume / (mrr * .72) + .8;
    const oneTools = nc?.toolNo ? '현재 T' + nc.toolNo : '1종 가정';
    $('processCompareResult').innerHTML = `<div class="plan-row"><b>단일 패스</b><span>${fmt(onePass)} min</span><small>${oneTools} · 교환 0회 가정</small></div><div class="plan-row"><b>황삭 + 정삭</b><span>${fmt(twoPass)} min</span><small>정삭 여유·저이송 가정 · 교환 1회</small></div><p>${twoPass < onePass ? '정삭으로 품질을 우선하는 설정이 시간 증가를 상쇄합니다.' : '이 단순 모델에서는 단일 패스가 빠릅니다. 공차·표면 요구가 있으면 황삭/정삭 분리 이점을 따져보세요.'} 두 패스 MRR은 단일 패스의 72%, 공구 교환은 0.8분으로 둔 가정입니다.</p>`;
    markLessonDone('process', '공정시간 비교는 제거 체적과 MRR에 좌우되며, 황삭·정삭은 품질 여유와 추가 시간이 함께 듭니다.', '두 단계 공정 비교에서 시간에 더해 따져야 할 것은?', [['quality', '정삭 여유와 요구 품질'], ['none', '시간만 비교하면 충분']], 'quality');
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function summary() {
    if (!nc) { $('programLearningSummary').textContent = 'NC 코드를 분석하면 공구, 이송, 시간, 경고를 이곳에 요약합니다.'; $('moduleLinkState').textContent = 'NC 코드 대기'; return; }
    const warnings = nc.warnings?.length || 0;
    $('moduleLinkState').textContent = nc.phase === 'complete' ? 'NC 결과 연결됨' : `NC ${nc.phase === 'ready' ? '분석 완료' : nc.phase}`;
    $('programLearningSummary').innerHTML = `<b>N${nc.lineNo || '—'} · ${nc.code ? escapeHtml(nc.code) : '계획 경로'}</b><br>T${nc.toolNo ?? '미지정'} · Ø${fmt(nc.diameter, 1)} mm · S${fmt(nc.rpm, 0)} rpm · F${fmt(nc.feed, 0)} mm/min<br>절삭시간 ${fmt(nc.cuttingSeconds, 1)} s · 제거 체적 ${fmt(nc.removedVolume, 3)} cm³ · 위험 후보/검토 ${warnings}건${warnings ? `<br><span class="module-warning">${escapeHtml(nc.warnings.slice(0, 3).join(' · '))}</span>` : ''}<br><small>이 값은 현재 NC 시뮬레이터가 지원하는 블록·간이 높이맵 결과이며 실제 기계 안전 검증을 뜻하지 않습니다.</small>`;
    setupFeedback();
  }
  $('compareFeed').addEventListener('click', conditionCompare);
  $('decodeProgram').addEventListener('click', () => { decode(); markLessonDone('code', '코드 줄의 G/M 명령, 좌표 주소와 위험 단서를 읽었습니다.', 'G0는 어떤 이동인가요?', [['rapid', '급속 위치결정'], ['feed', '절삭 이송']], 'rapid'); });
  $('codeQuiz').addEventListener('click', startQuiz);
  document.querySelectorAll('.setup-checklist input').forEach(x => x.addEventListener('change', setupFeedback));
  $('checkDiagnosis').addEventListener('click', diagnose);
  $('nextDefect').addEventListener('click', () => { caseIndex = (caseIndex + 1) % cases.length; showCase(); });
  $('comparePlans').addEventListener('click', comparePlans);
  $('checkReflection').addEventListener('click', () => {
    const select = $('reflectionAnswer');
    if (!select.value) { $('reflectionFeedback').textContent = '답을 먼저 선택하세요.'; return; }
    const correct = select.value === select.dataset.answer;
    $('reflectionFeedback').textContent = correct ? '정답입니다. 핵심 내용을 확인했습니다.' : '다시 생각해 보세요. 위 설명과 질문을 확인한 뒤 다시 선택할 수 있습니다.';
    $('reflectionFeedback').className = `reflection-feedback ${correct ? 'good' : 'bad'}`;
    if (correct) {
      const text = $('reflectionQuestion').textContent;
      const id = text.startsWith('F를') ? 'condition' : text.startsWith('현재 퀴즈') || text.startsWith('G0') ? 'code' : text.startsWith('코드 실행') ? 'setup' : text.startsWith('주기적인') ? 'diagnosis' : 'process';
      progress.verified[id] = true;
      try { localStorage.setItem(progressKey, JSON.stringify(progress)); } catch { /* current session still works */ }
      updateProgress();
    }
  });
  $('gcodeInput').addEventListener('input', () => { nc = null; summary(); });
  window.addEventListener('mct:nc-link', (e) => { const d = e.detail || {}; nc = ['edited', 'manual'].includes(d.phase) ? null : d; summary(); if ($('codeLessonResult').querySelector('.decoded-list')) decode(); });
  showCase(); setupFeedback();
  const initialNcState = window.__mctNcLinkState;
  if (initialNcState && !['edited', 'manual'].includes(initialNcState.phase)) { nc = initialNcState; summary(); }
  updateProgress();
  if (!initialNcState && $('gcodeInput')?.value.trim() && $('lineCount')?.textContent !== 'EDITING') {
    window.setTimeout(() => { if (!nc && $('lineCount')?.textContent !== 'EDITING') $('parseProgram').click(); }, 0);
  }
})();
