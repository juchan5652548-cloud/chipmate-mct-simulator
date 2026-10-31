(() => {
  const $ = (id) => document.getElementById(id);
  const SAMPLE = `%
O1001 (3 AXIS MILLING - G54 origin at stock lower left top)
G21 G90 G17 G54 G40 G49 G80 G94
T1 M6
G43 H1
S5700 M3
G0 X-8 Y-8 Z5
G0 X10 Y10
G1 Z-2 F240
G1 X50 F720
G1 Y30
G1 X10
G1 Y10
G0 Z5
G0 X15 Y15
G1 Z-4 F180
G1 X45 F600
G1 Y25
G1 X15
G1 Y15
G0 Z10
M9
M5
M30
%`;

  const supportedG = new Set([0, 1, 2, 3, 17, 18, 19, 20, 21, 40, 43, 49, 54, 73, 80, 81, 82, 83, 90, 91, 94, 98, 99]);
  const blocks = [];
  let parsedBlocks = [];
  let executed = 0;
  let timer = null;
  let warnings = [];
  let fatal = '';
  let cutDepth = null;
  let cutCount = 0;
  let elapsedSeconds = 0;
  let cuttingSeconds = 0;
  let paused = false;
  let parserSummary = null;
  let resolution = 0.5;
  const palette = { stock: '#80aaa1', top: '#a8c6bf', cut: '#d2e4dd', wall: '#628d84', fixture: '#ba8c59', tool: '#e18a48', path: '#087c6c', rapid: '#d88f45', alarm: '#c74242' };

  const num = (id, fallback) => Math.max(Number($(id)?.value) || fallback, 0.1);
  const stock = () => ({ x: num('stockX', 60), y: num('stockY', 40), z: num('stockZ', 20) });
  const tool = () => ({ diameter: num('toolDiameter', 10), teeth: Math.max(1, Math.round(num('toolTeeth', 4))), flute: num('fluteLength', 20), holder: Math.max(num('holderDiameter', 16), num('toolDiameter', 10)), overhang: num('toolOverhang', 32) });
  const fixtureEnabled = () => $('useFixture')?.checked;
  const startState = () => ({ position: { x: 0, y: 0, z: 5 }, motion: 0, absolute: true, unit: 1, feed: 0, spindleSpeed: 0, spindleOn: false, coolant: false, selectedTool: null, activeTool: null, plane: 17, cycle: 0, retractMode: 98, toolLengthOffset: 0, toolLengthComp: false, workSystem: 54, ended: false, stopped: false });
  function clonePoint(p) { return { x: p.x, y: p.y, z: p.z }; }
  function fmt(n) { return Number(n).toFixed(3); }
  function wordsFrom(line) { return [...line.matchAll(/([A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/gi)].map(m => ({ letter: m[1].toUpperCase(), value: Number(m[2]) })); }
  function stripComments(line) { return line.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim().toUpperCase(); }

  function interpolateLine(from, to, rapid, state, lineNo, warningsLocal) {
    const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const steps = Math.max(1, Math.ceil(d / Math.max(resolution * 0.5, 0.2)));
    const path = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      path.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t });
    }
    return { from: clonePoint(from), to: clonePoint(to), rapid, cut: !rapid, spindleOn: state.spindleOn, feed: state.feed, spindleSpeed: state.spindleSpeed, activeTool: state.activeTool, toolLengthOffset: state.toolLengthOffset, lineNo, path, alarm: false, warnings: warningsLocal };
  }

  function arcPoints(from, to, i, j, clockwise, radiusWord) {
    let cx, cy;
    if (Number.isFinite(i) && Number.isFinite(j)) { cx = from.x + i; cy = from.y + j; }
    else {
      const radius = Math.abs(radiusWord || 0), dx = to.x - from.x, dy = to.y - from.y;
      const chord = Math.hypot(dx, dy);
      if (radius < chord / 2 || chord < 1e-7) return null;
      const h = Math.sqrt(Math.max(0, radius * radius - chord * chord / 4));
      const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
      const candidates = [1, -1].map(sign => ({ x: mx + sign * (-dy / chord) * h, y: my + sign * (dx / chord) * h }));
      const wantMajor = radiusWord < 0;
      const candidatesWithSweep = candidates.map(c => {
        const a0 = Math.atan2(from.y - c.y, from.x - c.x), a1 = Math.atan2(to.y - c.y, to.x - c.x);
        let sweep = a1 - a0;
        if (clockwise && sweep >= 0) sweep -= Math.PI * 2;
        if (!clockwise && sweep <= 0) sweep += Math.PI * 2;
        return { ...c, sweep };
      });
      const chosen = candidatesWithSweep.find(c => (Math.abs(c.sweep) > Math.PI) === wantMajor) || candidatesWithSweep[0];
      cx = chosen.x; cy = chosen.y;
    }
    const r = Math.hypot(from.x - cx, from.y - cy);
    if (!r) return null;
    const a0 = Math.atan2(from.y - cy, from.x - cx), a1 = Math.atan2(to.y - cy, to.x - cx);
    let sweep = a1 - a0;
    if (clockwise && sweep >= 0) sweep -= Math.PI * 2;
    if (!clockwise && sweep <= 0) sweep += Math.PI * 2;
    if (Math.hypot(to.x - from.x, to.y - from.y) < 1e-7) sweep = clockwise ? -Math.PI * 2 : Math.PI * 2;
    const n = Math.max(8, Math.ceil(Math.abs(sweep) * r / Math.max(resolution * 0.5, 0.2)));
    const aStart = Math.atan2(from.y - cy, from.x - cx), pts = [];
    for (let k = 1; k <= n; k++) {
      const t = k / n, a = aStart + sweep * t;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: from.z + (to.z - from.z) * t });
    }
    return pts;
  }

  function parseProgram(text) {
    const state = startState(), result = [], issues = [], fatalErrors = [];
    const rows = text.split(/\r?\n/);
    for (let index = 0; index < rows.length; index++) {
      const raw = rows[index], clean = stripComments(raw);
      if (!clean || clean === '%' || /^O\d+\s*(?:\([^)]*\))?$/.test(clean)) continue;
      if (clean.startsWith('/')) { issues.push(`N${index + 1}: 블록 삭제(/) 코드는 옵션 설정을 확인해야 하므로 현재는 건너뜁니다.`); continue; }
      if (state.ended) break;
      state.stopped = false;
      const words = wordsFrom(clean);
      const macroLine = /#|\[|\]|\bO\d+\s+(?:CALL|SUB|ENDSUB|WHILE|IF|REPEAT|END)\b/i.test(clean);
      if (macroLine || /\bA[+-]?(?:\d|\.)|\bB[+-]?(?:\d|\.)|\bC[+-]?(?:\d|\.)|\bU[+-]?(?:\d|\.)|\bV[+-]?(?:\d|\.)|\bW[+-]?(?:\d|\.)/i.test(clean)) {
        const issue = macroLine ? '매크로/파라미터/서브프로그램 코드는 지원하지 않아 이 블록을 해석할 수 없습니다.' : 'A/B/C/U/V/W 회전·추가 축은 3축 모델에서 검증할 수 없습니다.';
        issues.push(`N${index + 1}: ${issue}`);
        result.push({ lineNo: index + 1, source: raw.trim(), segments: [], end: clonePoint(state.position), feed: state.feed, spindleSpeed: state.spindleSpeed, spindleOn: state.spindleOn, coolant: state.coolant, selectedTool: state.selectedTool, activeTool: state.activeTool, motion: state.motion, workSystem: state.workSystem, ended: false, stopped: false, mText: '', issues: [issue], blocked: true });
        continue;
      }
      if (!words.length) {
        const issue = '해석 가능한 주소가 없는 코드 행입니다. 이 행의 의미를 확인해야 합니다.';
        issues.push(`N${index + 1}: ${issue}`);
        result.push({ lineNo: index + 1, source: raw.trim(), segments: [], end: clonePoint(state.position), feed: state.feed, spindleSpeed: state.spindleSpeed, spindleOn: state.spindleOn, coolant: state.coolant, selectedTool: state.selectedTool, activeTool: state.activeTool, motion: state.motion, workSystem: state.workSystem, ended: false, stopped: false, mText: '', issues: [issue], blocked: true });
        continue;
      }
      const lineIssues = [];
      const gWords = words.filter(w => w.letter === 'G');
      const mWords = words.filter(w => w.letter === 'M');
      const gCodes = gWords.map(w => w.value);
      const mCodes = mWords.map(w => Math.round(w.value));
      if (mWords.some(w => !Number.isInteger(w.value))) lineIssues.push('M코드는 정수 형식이어야 합니다.');
      const val = (letter) => { const x = words.filter(w => w.letter === letter).at(-1); return x?.value; };
      const supportedAddress = new Set(['N','O','G','M','X','Y','Z','I','J','K','R','P','Q','F','S','T','H','D']);
      words.filter(w => !supportedAddress.has(w.letter)).forEach(w => lineIssues.push(`지원하지 않는 주소 ${w.letter}`));
      const intGs = gCodes.map(g => Math.round(g * 10) / 10);
      intGs.forEach(g => { if (!supportedG.has(g)) lineIssues.push(`지원하지 않는 G${g} 코드`); });
      const modalGroups = [[0,1,2,3,73,81,82,83],[17,18,19],[20,21],[90,91],[54,55,56,57,58,59]];
      modalGroups.forEach(group => { const present = gCodes.filter(g => group.includes(g)); if (new Set(present).size > 1) lineIssues.push(`같은 모달 그룹의 G코드가 한 블록에 중복되었습니다: ${present.map(g => `G${g}`).join('/')}`); });
      if (mCodes.filter(m => [3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 30].includes(m)).length > 1) lineIssues.push('한 블록의 복수 M코드 실행 순서는 제어기마다 달라 해석하지 않습니다.');
      if (mCodes.some(m => ![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30].includes(m))) lineIssues.push(`지원하지 않는 M${mCodes.filter(m => ![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30].includes(m)).join('/')} 코드`);

      if (gCodes.includes(20)) state.unit = 25.4;
      if (gCodes.includes(21)) state.unit = 1;
      if (gCodes.includes(90)) state.absolute = true;
      if (gCodes.includes(91)) state.absolute = false;
      [17, 18, 19].forEach(p => { if (gCodes.includes(p)) state.plane = p; });
      if (gCodes.some(g => [55, 56, 57, 58, 59].includes(g))) lineIssues.push('G55-G59 work offset은 별도 오프셋 값이 설정되지 않아 검증하지 않습니다.');
      if (gCodes.includes(54)) state.workSystem = 54;
      if (gCodes.includes(43)) {
        const hNumber = val('H');
        if (hNumber === undefined || hNumber !== num('toolHNumber', 1)) lineIssues.push('G43 H 번호가 현재 설정한 단일 공구 길이 보정 번호와 일치하지 않습니다.');
        else { state.toolLengthComp = true; state.toolLengthOffset = num('toolLengthOffset', 0); }
      }
      if (gCodes.includes(49)) { state.toolLengthComp = false; state.toolLengthOffset = 0; }
      if (gCodes.some(g => g === 41 || g === 42 || g === 40)) {
        if (gCodes.some(g => g === 41 || g === 42)) lineIssues.push('공구 반경 보정 G41/G42는 미지원입니다. CAM에서 보정된 경로를 사용하세요.');
      }
      if (gCodes.includes(82) && val('P') !== undefined) lineIssues.push('G82 정지시간 P는 형상에는 반영하지 않으며 사이클 시간에서 제외합니다.');
      if (gCodes.includes(53) || gCodes.includes(28) || gCodes.includes(30)) lineIssues.push('기계 좌표/기계 원점 이동은 머신 모델 미설정으로 지원하지 않습니다.');
      const newMotion = [0, 1, 2, 3].find(g => gCodes.includes(g));
      if (newMotion !== undefined) state.motion = newMotion;
      if (gCodes.includes(80)) state.cycle = 0;
      if ([73, 81, 82, 83].some(g => gCodes.includes(g))) state.cycle = gCodes.find(g => [73, 81, 82, 83].includes(g));
      if (gCodes.includes(98)) state.retractMode = 98;
      if (gCodes.includes(99)) state.retractMode = 99;
      if (val('F') !== undefined) state.feed = val('F') * state.unit;
      if (val('S') !== undefined) state.spindleSpeed = val('S');
      if (val('T') !== undefined) state.selectedTool = Math.round(val('T'));

      for (const m of mCodes) {
        if (m === 3 || m === 4) state.spindleOn = true;
        if (m === 5) state.spindleOn = false;
        if (m === 6) {
          if (state.selectedTool === null) lineIssues.push('M6 앞에 T 공구 번호가 지정되지 않았습니다.');
          else state.activeTool = state.selectedTool;
        }
        if (m === 7 || m === 8) state.coolant = true;
        if (m === 9) state.coolant = false;
        if (m === 0 || m === 1) state.stopped = true;
        if (m === 2 || m === 30) state.ended = true;
      }

      const start = clonePoint(state.position), hasAxis = ['X', 'Y', 'Z'].some(a => val(a) !== undefined);
      const end = {
        x: val('X') === undefined ? start.x : (state.absolute ? val('X') * state.unit : start.x + val('X') * state.unit),
        y: val('Y') === undefined ? start.y : (state.absolute ? val('Y') * state.unit : start.y + val('Y') * state.unit),
        z: val('Z') === undefined ? start.z : (state.absolute ? val('Z') * state.unit : start.z + val('Z') * state.unit)
      };
      const segments = [];
      const cycle = state.cycle;
      const isCycle = cycle && hasAxis && (val('X') !== undefined || val('Y') !== undefined || gCodes.includes(cycle));
      if (isCycle) {
        const retract = val('R') === undefined ? (state.cycleRetract ?? 2 * state.unit) : (state.absolute ? val('R') * state.unit : start.z + val('R') * state.unit);
        const targetZ = val('Z') === undefined ? (state.cycleDepth ?? start.z) : (state.absolute ? val('Z') * state.unit : start.z + val('Z') * state.unit);
        if (val('Z') !== undefined) state.cycleDepth = targetZ;
        if (val('R') !== undefined) state.cycleRetract = retract;
        const hole = { x: end.x, y: end.y, z: start.z };
        if (distance2(hole, start) > 0) segments.push(interpolateLine(start, hole, true, state, index + 1, lineIssues));
        let cursor = clonePoint(hole); cursor.z = retract;
        if (state.motion === 0 || state.motion === 1) {
          if (cursor.z !== hole.z) segments.push(interpolateLine(hole, cursor, true, state, index + 1, lineIssues));
          if (cycle === 83 || cycle === 73) {
            const peck = Math.max((val('Q') || 2) * state.unit, 0.1); let depth = retract;
            while (depth > targetZ) { depth = Math.max(targetZ, depth - peck); const next = { x: cursor.x, y: cursor.y, z: depth }; segments.push(interpolateLine(cursor, next, false, state, index + 1, lineIssues)); cursor = next; if (depth > targetZ) { const chipClear = { ...cursor, z: cycle === 83 ? retract : Math.min(depth + Math.max(peck * .25, .5), retract) }; segments.push(interpolateLine(cursor, chipClear, true, state, index + 1, lineIssues)); cursor = chipClear; } }
          } else {
            const next = { x: cursor.x, y: cursor.y, z: targetZ };
            segments.push(interpolateLine(cursor, next, false, state, index + 1, lineIssues)); cursor = next;
          }
          const safe = state.retractMode === 98 ? start.z : retract;
          if (cursor.z !== safe) segments.push(interpolateLine(cursor, { ...cursor, z: safe }, true, state, index + 1, lineIssues));
        }
        state.position = { x: end.x, y: end.y, z: state.retractMode === 98 ? start.z : retract };
      } else if (hasAxis) {
        if (state.motion === 2 || state.motion === 3) {
          if (state.plane !== 17) lineIssues.push(`G${state.motion} 원호는 현재 XY 평면(G17)에서만 검증합니다.`);
          else {
            const i = val('I') === undefined ? undefined : val('I') * state.unit;
            const j = val('J') === undefined ? undefined : val('J') * state.unit;
            const radius = val('R') === undefined ? undefined : val('R') * state.unit;
            if ((i === undefined || j === undefined) && radius === undefined) lineIssues.push('원호 이동에 I/J 또는 R 값이 필요합니다.');
            else {
              const pts = arcPoints(start, end, i, j, state.motion === 2, radius);
              if (!pts) lineIssues.push('원호 반경 또는 끝점이 기하학적으로 유효하지 않습니다.');
              else { let prev = start; pts.forEach(p => { segments.push(interpolateLine(prev, p, false, state, index + 1, lineIssues)); prev = p; }); }
            }
          }
        } else segments.push(interpolateLine(start, end, state.motion === 0, state, index + 1, lineIssues));
        state.position = end;
      }
      issues.push(...lineIssues.map(issue => `N${index + 1}: ${issue}`));
      const mText = mCodes.map(m => `M${m}`).join(' ');
      if (segments.some(seg => seg.cut) && state.activeTool === null) lineIssues.push('활성 공구/공구 형상이 설정되지 않아 절삭 블록을 검증할 수 없습니다.');
      const blocked = lineIssues.some(issue => /지원하지 않는 (G|M|주소)|M코드는 정수|G43 H|G41\/G42|G55-G59|기계 좌표|원호는 현재|원호 이동|원호 반경|복수 M코드|같은 모달 그룹|활성 공구/.test(issue));
      result.push({ lineNo: index + 1, source: raw.trim(), segments, end: clonePoint(state.position), feed: state.feed, spindleSpeed: state.spindleSpeed, spindleOn: state.spindleOn, coolant: state.coolant, selectedTool: state.selectedTool, activeTool: state.activeTool, motion: state.motion, workSystem: state.workSystem, ended: state.ended, stopped: state.stopped, mText, issues: lineIssues, blocked });
      if (state.ended) break;
    }
    return { blocks: result, issues, fatalErrors };
  }
  function distance2(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function resetStock() {
    const s = stock();
    resolution = Math.max(0.5, Math.sqrt(s.x * s.y / 40000));
    cutDepth = new Float32Array(Math.ceil(s.x / resolution) * Math.ceil(s.y / resolution));
    cutCount = 0;
    elapsedSeconds = 0;
    cuttingSeconds = 0;
  }
  function dims() { const s = stock(); return { nx: Math.ceil(s.x / resolution), ny: Math.ceil(s.y / resolution), s }; }
  function clampDepth(depth) { return Math.min(Math.max(depth, 0), stock().z); }
  function addCut(seg, alarms) {
    if (!seg.cut || seg.rapid) return;
    if (!seg.spindleOn) { alarms.add(`N${seg.lineNo}: 주축 M3/M4 없이 이송 절삭 경로가 있습니다.`); seg.alarm = true; return; }
    if (seg.spindleSpeed <= 0) { alarms.add(`N${seg.lineNo}: 주축 회전수 S가 0 또는 미설정이라 소재 제거를 계산하지 않습니다.`); seg.alarm = true; return; }
    if (seg.feed <= 0) { alarms.add(`N${seg.lineNo}: 절삭 이송 F값이 0 또는 미설정입니다.`); seg.alarm = true; return; }
    const s = stock(), t = tool(), { nx, ny } = dims();
    const radius = t.diameter / 2, pitch = resolution;
    const from = seg.from, to = seg.to;
    const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const samples = Math.max(1, Math.ceil(length / (pitch * .45)));
    for (let step = 0; step <= samples; step++) {
      const u = step / samples;
      const x = from.x + (to.x - from.x) * u, y = from.y + (to.y - from.y) * u, z = from.z + (to.z - from.z) * u;
      const depth = clampDepth(-z);
      if (depth <= 0) continue;
      const ix0 = Math.max(0, Math.floor((x - radius) / pitch)); const ix1 = Math.min(nx - 1, Math.ceil((x + radius) / pitch));
      const iy0 = Math.max(0, Math.floor((y - radius) / pitch)); const iy1 = Math.min(ny - 1, Math.ceil((y + radius) / pitch));
      for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
        const cx = (ix + .5) * pitch, cy = (iy + .5) * pitch;
        if ((cx - x) ** 2 + (cy - y) ** 2 <= radius ** 2) {
          const at = iy * nx + ix;
          if (depth > cutDepth[at]) { if (!cutDepth[at]) cutCount++; cutDepth[at] = depth; }
        }
      }
    }
  }
  function fixtureBoxes() {
    const s = stock(), width = num('viseJawWidth', 8), gap = Number($('viseOffset').value) || 0, top = Number($('viseHeight').value) || 0, embed = num('viseEmbed', 10);
    return [
      { x0: 0, x1: s.x, y0: -(gap + width), y1: -gap, z0: -embed, z1: top },
      { x0: 0, x1: s.x, y0: s.y + gap, y1: s.y + gap + width, z0: -embed, z1: top }
    ];
  }
  function segmentCheck(seg, alarms) {
    const s = stock(), t = tool();
    const ox = Number($('originX').value) || 0, oy = Number($('originY').value) || 0, oz = Number($('originZ').value) || 0;
    const maxX = num('travelX', 600), maxY = num('travelY', 400), maxZ = num('travelZ', 500);
    for (const p of seg.path) {
      const mx = ox + p.x, my = oy + p.y, mz = oz + p.z;
      const machineZ = mz + seg.toolLengthOffset;
      if (mx < 0 || mx > maxX || my < 0 || my > maxY || machineZ < 0 || machineZ > maxZ) { alarms.add(`N${seg.lineNo}: 설정한 기계 축 이동 범위를 벗어납니다.`); seg.alarm = true; }
      if (seg.cut && (p.x < -t.diameter / 2 || p.x > s.x + t.diameter / 2 || p.y < -t.diameter / 2 || p.y > s.y + t.diameter / 2)) { alarms.add(`N${seg.lineNo}: 절삭 경로가 소재 외곽을 벗어납니다.`); seg.alarm = true; }
      if (seg.cut && p.z < -s.z) { alarms.add(`N${seg.lineNo}: 공구 끝점이 소재 바닥보다 깊습니다.`); seg.alarm = true; }
      if (seg.rapid && p.z < 0 && cutDepth && p.x >= -t.diameter / 2 && p.x <= s.x + t.diameter / 2 && p.y >= -t.diameter / 2 && p.y <= s.y + t.diameter / 2) {
        const { nx, ny } = dims(), rad = t.diameter / 2, pitch = resolution;
        let hit = false;
        for (let iy=Math.max(0,Math.floor((p.y-rad)/pitch)); iy<=Math.min(ny-1,Math.ceil((p.y+rad)/pitch)) && !hit; iy++) for (let ix=Math.max(0,Math.floor((p.x-rad)/pitch)); ix<=Math.min(nx-1,Math.ceil((p.x+rad)/pitch)); ix++) {
          const cx=(ix+.5)*pitch,cy=(iy+.5)*pitch;
          if ((cx-p.x)**2+(cy-p.y)**2 <= rad**2 && cutDepth[iy*nx+ix] < -p.z-.1) { hit=true; break; }
        }
        if (hit) { alarms.add(`N${seg.lineNo}: 급속 이동 중 남은 소재와 공구가 간섭할 수 있습니다.`); seg.alarm = true; }
      }
      // Check flute-end / holder envelope against the remaining height-field stock.
      if (cutDepth && p.x >= 0 && p.x <= s.x && p.y >= 0 && p.y <= s.y) {
        const { nx, ny } = dims(), pitch = resolution;
        const rings = [
          { radius: t.diameter / 2, z0: p.z + t.flute, z1: p.z + t.overhang, label: '공구 넥' },
          { radius: t.holder / 2, z0: p.z + t.overhang, z1: p.z + t.overhang + 55, label: '홀더' }
        ];
        for (const ring of rings) {
          const ix0 = Math.max(0, Math.floor((p.x-ring.radius)/pitch)), ix1 = Math.min(nx-1, Math.ceil((p.x+ring.radius)/pitch));
          const iy0 = Math.max(0, Math.floor((p.y-ring.radius)/pitch)), iy1 = Math.min(ny-1, Math.ceil((p.y+ring.radius)/pitch));
          let hit = false;
          for (let iy=iy0; iy<=iy1 && !hit; iy++) for (let ix=ix0; ix<=ix1; ix++) {
            const cx=(ix+.5)*pitch, cy=(iy+.5)*pitch;
            if ((cx-p.x)**2+(cy-p.y)**2 > ring.radius**2) continue;
            const surface = -cutDepth[iy*nx+ix];
            if (surface > ring.z0 + .25 && -s.z < ring.z1) { hit = true; break; }
          }
          if (hit) { alarms.add(`N${seg.lineNo}: 남은 소재와 ${ring.label} 간섭 가능성`); seg.alarm = true; }
        }
      }
      if (fixtureEnabled()) {
        const fluteTop = p.z + t.flute;
        fixtureBoxes().forEach((box, index) => {
          const nx = Math.max(box.x0 - p.x, 0, p.x - box.x1), ny = Math.max(box.y0 - p.y, 0, p.y - box.y1);
          const overlapsTool = nx * nx + ny * ny <= (t.diameter / 2) ** 2 && p.z < box.z1 && fluteTop > box.z0;
          const holderBottom = p.z + t.overhang;
          const overlapsHolder = nx * nx + ny * ny <= (t.holder / 2) ** 2 && holderBottom < box.z1 && holderBottom + 60 > box.z0;
          if (overlapsTool || overlapsHolder) { alarms.add(`N${seg.lineNo}: ${index ? '후면' : '전면'} 바이스와 공구/홀더 간섭 가능성`); seg.alarm = true; }
        });
      }
    }
  }
  function checkBlock(block, alarms) {
    if (block.spindleOn && block.spindleSpeed <= 0 && block.segments.some(s => s.cut)) alarms.add(`N${block.lineNo}: 주축이 켜졌지만 S 회전수가 설정되지 않았습니다.`);
    if (block.spindleSpeed > num('maxRpm', 8000)) alarms.add(`N${block.lineNo}: S${block.spindleSpeed} rpm이 설정한 주축 최대 회전수를 넘습니다.`);
    block.segments.forEach(seg => { segmentCheck(seg, alarms); addCut(seg, alarms); });
    block.segments.forEach(seg => {
      let length = 0, prev = seg.from;
      seg.path.forEach(p => { length += Math.hypot(p.x-prev.x,p.y-prev.y,p.z-prev.z); prev = p; });
      const rate = seg.rapid ? num('maxRapid', 20000) : Math.max(seg.feed, 0);
      if (rate > 0) {
        const seconds = length / rate * 60;
        elapsedSeconds += seconds;
        if (seg.cut && seg.spindleOn && seg.spindleSpeed > 0) cuttingSeconds += seconds;
      }
    });
    if (block.activeTool === null && block.segments.some(s => s.cut)) alarms.add(`N${block.lineNo}: M6로 공구를 장착하지 않은 상태에서 절삭합니다.`);
  }
  function allPoints() {
    const p = [];
    parsedBlocks.forEach(b => b.segments.forEach(seg => { p.push(seg.from, seg.to); }));
    return p;
  }
  function iso(x, y, z, originX, originY, tileW, tileH, zScale) {
    return { x: originX + (x - y) * tileW / (2 * resolution), y: originY + (x + y) * tileH / (2 * resolution) - z * zScale };
  }
  function polygon(ctx, points, fill, stroke = null) {
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y); points.slice(1).forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = .35; ctx.stroke(); }
  }
  function depthColor(depth) {
    const f = Math.max(0, Math.min(depth / Math.max(stock().z, 1), 1));
    const a = [159, 193, 184], b = [205, 222, 213];
    return `rgb(${Math.round(a[0] + (b[0]-a[0])*f)},${Math.round(a[1] + (b[1]-a[1])*f)},${Math.round(a[2] + (b[2]-a[2])*f)})`;
  }
  function render() {
    const canvas = $('toolpathCanvas'); if (!canvas) return;
    const r = canvas.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return;
    const dpr = window.devicePixelRatio || 1; canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
    ctx.fillStyle = '#f5f8f7'; ctx.fillRect(0, 0, r.width, r.height);
    const s = stock(), { nx, ny } = dims(), pts = allPoints(), jaw = fixtureEnabled() ? num('viseJawWidth',8) + (Number($('viseOffset').value)||0) : 0;
    const xMin = Math.min(0, ...pts.map(p => p.x)), xMax = Math.max(s.x, ...pts.map(p => p.x));
    const yMin = Math.min(-jaw, ...pts.map(p => p.y)), yMax = Math.max(s.y + jaw, ...pts.map(p => p.y));
    const rangeX = Math.max(xMax - xMin, 1), rangeY = Math.max(yMax - yMin, 1), zTop = Math.max(5, ...pts.map(p => p.z)), zBottom = -s.z;
    const projectionFactor = (rangeX + rangeY) / (2 * resolution);
    let tw = Math.min(5.2, (r.width - 48) / projectionFactor, (r.height - 62) / (projectionFactor * .52 + (zTop - zBottom) * .5));
    tw = Math.max(.2, tw);
    const th = tw * .52, zScale = Math.max(.2, Math.min(2.5, (r.height - 62 - projectionFactor * th) / (zTop - zBottom)));
    const projectedWidth = projectionFactor * tw;
    const projectedHeight = projectionFactor * th + (zTop - zBottom) * zScale;
    const baseX = (r.width - projectedWidth) / 2 - (xMin - yMax) * tw / (2 * resolution);
    const baseY = Math.max(20, (r.height - projectedHeight) / 2 - (xMin + yMin) * th / (2 * resolution) + zTop * zScale);
    const cell = (ix, iy) => (iy < 0 || ix < 0 || ix >= nx || iy >= ny || !cutDepth) ? 0 : cutDepth[iy * nx + ix];
    const topPt = (ix, iy, depth) => iso(ix * resolution, iy * resolution, -depth, baseX, baseY, tw, th, zScale);
    const bottomZ = -s.z;
    // Isometric 2.5D stock: swept flat-endmill envelope modifies the height field.
    for (let sum = 0; sum <= nx + ny - 2; sum++) {
      const x0 = Math.max(0, sum - ny + 1), x1 = Math.min(nx - 1, sum);
      for (let ix = x0; ix <= x1; ix++) {
        const iy = sum - ix, depth = cell(ix, iy), z = -depth;
        const p0 = topPt(ix, iy, depth), p1 = topPt(ix + 1, iy, depth), p2 = topPt(ix + 1, iy + 1, depth), p3 = topPt(ix, iy + 1, depth);
        polygon(ctx, [p0, p1, p2, p3], depthColor(depth), '#70978d');
        const rightDepth = cell(ix + 1, iy);
        if (ix === nx - 1 || rightDepth > depth + .01) {
          const lower = ix === nx - 1 ? bottomZ : -rightDepth;
          const q1 = iso((ix + 1) * resolution, iy * resolution, lower, baseX, baseY, tw, th, zScale);
          const q2 = iso((ix + 1) * resolution, (iy + 1) * resolution, lower, baseX, baseY, tw, th, zScale);
          polygon(ctx, [p1, q1, q2, p2], '#73998f', '#5b8179');
        }
        const frontDepth = cell(ix, iy + 1);
        if (iy === ny - 1 || frontDepth > depth + .01) {
          const lower = iy === ny - 1 ? bottomZ : -frontDepth;
          const q1 = iso(ix * resolution, (iy + 1) * resolution, lower, baseX, baseY, tw, th, zScale);
          const q2 = iso((ix + 1) * resolution, (iy + 1) * resolution, lower, baseX, baseY, tw, th, zScale);
          polygon(ctx, [p3, p2, q2, q1], '#5f877e', '#547a73');
        }
      }
    }
    // Fixture jaws are rendered as configurable virtual vise envelopes.
    if (fixtureEnabled()) fixtureBoxes().forEach((b, i) => {
      const color = i ? '#b48a5d' : '#c39a69';
      const a = iso(b.x0, b.y0, b.z1, baseX, baseY, tw, th, zScale), c = iso(b.x1, b.y0, b.z1, baseX, baseY, tw, th, zScale), d = iso(b.x1, b.y1, b.z1, baseX, baseY, tw, th, zScale), e = iso(b.x0, b.y1, b.z1, baseX, baseY, tw, th, zScale);
      polygon(ctx, [a,c,d,e], '#d1ad80', '#a67e50');
      const c0 = iso(b.x1,b.y0,b.z0,baseX,baseY,tw,th,zScale), d0 = iso(b.x1,b.y1,b.z0,baseX,baseY,tw,th,zScale), e0 = iso(b.x0,b.y1,b.z0,baseX,baseY,tw,th,zScale);
      polygon(ctx, [c,c0,d0,d], color, '#9f784b'); polygon(ctx, [e,d,d0,e0], '#a67e50', '#8e6c46');
    });
    // Full-program path is faint; executed path is emphasized and alarms are red.
    let globalIndex = 0, runPoint = null;
    parsedBlocks.forEach((block, bi) => block.segments.forEach(seg => {
      const done = bi < executed, alarm = seg.alarm;
      const p0 = iso(seg.from.x, seg.from.y, seg.from.z, baseX, baseY, tw, th, zScale), p1 = iso(seg.to.x, seg.to.y, seg.to.z, baseX, baseY, tw, th, zScale);
      ctx.beginPath(); ctx.moveTo(p0.x,p0.y); ctx.lineTo(p1.x,p1.y);
      ctx.strokeStyle = alarm ? palette.alarm : seg.rapid ? (done ? palette.rapid : '#d8b48b') : (done ? palette.path : '#9fc9bf');
      ctx.lineWidth = done ? 2 : 1.2; ctx.setLineDash(seg.rapid ? [4,3] : []); ctx.stroke(); ctx.setLineDash([]);
      globalIndex++;
      if (done) runPoint = p1;
    }));
    const last = executed ? parsedBlocks[executed - 1] : null;
    const current = last ? last.end : { x: 0, y: 0, z: 5 };
    const toolPt = iso(current.x, current.y, current.z, baseX, baseY, tw, th, zScale);
    const rad = Math.max(5, tool().diameter * tw / resolution / 2);
    ctx.beginPath(); ctx.ellipse(toolPt.x, toolPt.y, rad, rad * .5, 0, 0, Math.PI * 2); ctx.fillStyle = '#e18a4850'; ctx.fill(); ctx.strokeStyle = '#e18a48'; ctx.lineWidth = 2; ctx.stroke();
    const toolTop = iso(current.x, current.y, current.z + tool().flute, baseX, baseY, tw, th, zScale);
    ctx.beginPath(); ctx.moveTo(toolPt.x, toolPt.y); ctx.lineTo(toolTop.x, toolTop.y); ctx.strokeStyle = '#d59457'; ctx.lineWidth = Math.max(3, rad * .55); ctx.stroke();
    ctx.fillStyle = '#607a74'; ctx.font = '9px DM Sans, sans-serif'; ctx.fillText(`소재 ${s.x}×${s.y}×${s.z} mm · XY 해상도 ${resolution} mm`, 10, r.height - 9);
    $('canvasEmpty').classList.toggle('hidden', parsedBlocks.length > 0);
  }

  function analyze(reset = true) {
    stop();
    const output = parseProgram($('gcodeInput').value);
    parsedBlocks = output.blocks; warnings = output.issues; fatal = '';
    if (!parsedBlocks.length) fatal = '실행 가능한 NC 블록이 없습니다.';
    if (reset) { executed = 0; paused = false; resetStock(); parsedBlocks.forEach(b => b.segments.forEach(seg => { seg.alarm = false; })); }
    refresh();
  }
  function runBlock() {
    if (executed >= parsedBlocks.length) { stop(); return; }
    const block = parsedBlocks[executed], alarms = new Set();
    if (block.blocked) {
      fatal = `N${block.lineNo}에서 해석 불가 코드가 있어 검증을 중단했습니다: ${block.issues.join(' · ')}`;
      warnings = [...new Set([...warnings, ...block.issues.map(issue => `N${block.lineNo}: ${issue}`)])];
      stop(); paused = false; refresh(); return;
    }
    checkBlock(block, alarms);
    warnings = [...new Set([...warnings, ...alarms])];
    executed++;
    refresh();
    if (block.stopped) { stop(); paused = true; $('programStatus').textContent = '프로그램 정지(M00/M01) · 계속 실행을 눌러 재개'; refresh(); }
    else if (block.ended || executed >= parsedBlocks.length) { stop(); paused = false; refresh(); }
  }
  function publishLinkState(block) {
    const planned = parsedBlocks.find(b => b.segments.some(seg => seg.cut)) || parsedBlocks.find(b => b.spindleSpeed > 0);
    const source = block || planned;
    const segments = parsedBlocks.slice(0, executed).flatMap(b => b.segments);
    const pathForDepth = executed ? segments : (planned?.segments || parsedBlocks.flatMap(b => b.segments));
    let maxDepth = 0;
    pathForDepth.forEach(seg => seg.path.forEach(p => { if (p.z < 0) maxDepth = Math.max(maxDepth, -p.z); }));
    const removed = cutDepth ? cutDepth.reduce((sum, depth) => sum + depth, 0) * resolution * resolution / 1000 : 0;
    const mrr = cuttingSeconds > 0 ? removed / (cuttingSeconds / 60) : 0;
    const phase = fatal ? 'error' : paused ? 'paused' : executed >= parsedBlocks.length && parsedBlocks.length ? 'complete' : executed > 0 || timer ? 'running' : 'ready';
    const linkDetail = {
      phase,
      lineNo: source?.lineNo || 0,
      code: source?.source || '',
      rpm: source?.spindleSpeed || 0,
      feed: source?.feed || 0,
      toolNo: source?.activeTool ?? source?.selectedTool ?? null,
      diameter: tool().diameter,
      teeth: tool().teeth,
      vc: (source?.spindleSpeed || 0) * Math.PI * tool().diameter / 1000,
      fz: source?.spindleSpeed > 0 ? (source?.feed || 0) / (source.spindleSpeed * tool().teeth) : 0,
      cutDepth: maxDepth,
      removedVolume: removed,
      mrr,
      elapsedSeconds,
      cuttingSeconds,
      workSystem: source?.workSystem || 54,
      warnings: [...warnings]
    };
    window.__mctNcLinkState = linkDetail;
    window.dispatchEvent(new CustomEvent('mct:nc-link', { detail: linkDetail }));
  }
  function refresh() {
    const count = parsedBlocks.length, block = executed ? parsedBlocks[executed - 1] : null;
    $('blockIndicator').textContent = `BLOCK ${executed} / ${count}`;
    $('lineCount').textContent = `${count} BLOCKS`;
    $('programStatus').textContent = fatal || (executed >= count && count ? 'NC 프로그램 재생 완료' : `${count}개 NC 블록 분석 · ${executed}개 실행`);
    const p = block?.end || { x: 0, y: 0, z: 5 };
    $('positionReadout').textContent = `X ${fmt(p.x)}　Y ${fmt(p.y)}　Z ${fmt(p.z)}`;
    $('activeCode').textContent = block ? `N${block.lineNo}  ${block.source}` : '대기 중';
    $('spindleReadout').textContent = `${block?.spindleOn ? `M3/M4 · ${block.spindleSpeed} rpm` : 'OFF'} · F${fmt(block?.feed || 0)}${block?.coolant ? ' · COOLANT' : ''}`;
    $('toolReadout').textContent = block?.activeTool ? `T${block.activeTool} · Ø${tool().diameter}` : `미장착 · 선택 T${block?.selectedTool ?? '—'}`;
    const removed = cutDepth ? cutDepth.reduce((sum, depth) => sum + depth, 0) * resolution * resolution / 1000 : 0;
    $('volumeReadout').textContent = `${removed.toFixed(3)} cm³`;
    $('timeReadout').textContent = `${elapsedSeconds.toFixed(1)} s`;
    const msg = $('ncMessages'); msg.className = 'nc-messages';
    if (fatal) { msg.textContent = fatal; msg.classList.add('error'); }
    else if (warnings.length) { msg.textContent = `검토 경고 ${warnings.length}건: ${warnings.slice(-3).join(' · ')}`; msg.classList.add(warnings.some(w => /간섭|범위 밖|주축/.test(w)) ? 'error' : 'warning'); }
    else msg.textContent = executed ? '현재까지의 블록에서 등록된 충돌·해석 경고가 없습니다.' : '코드 분석 후 전체 재생 또는 한 블록씩 실행하세요.';
    render();
    publishLinkState(block);
  }
  function stop() { if (timer) clearInterval(timer); timer = null; if ($('runProgram')) $('runProgram').innerHTML = '<span>▶</span> 전체 실행'; }
  function selectProfile() {
    const profile = $('dialect').value;
    const labels = { generic: 'ISO 밀링 공통 코드 · RS274 기반', fanuc: 'FANUC 0i 프로파일 · 공통 subset', haas: 'Haas NGC 프로파일 · 공통 subset', linuxcnc: 'LinuxCNC RS274/NGC · 공통 subset' };
    $('profileLabel').textContent = labels[profile];
    warnings = warnings.filter(w => !w.startsWith('현재 프로파일'));
    warnings.push('현재 프로파일은 공통 G/M 코드 해석만 선택합니다. 옵션 M코드·파라미터·매크로·기계별 동작은 별도 설정이 필요합니다.');
    refresh();
  }
  $('gcodeInput').value = SAMPLE;
  resetStock();
  $('loadSample').addEventListener('click', () => { $('gcodeInput').value = SAMPLE; analyze(); });
  $('openFile').addEventListener('click', () => $('gcodeFile').click());
  $('gcodeFile').addEventListener('change', async (event) => { const file = event.target.files?.[0]; if (file) { $('gcodeInput').value = await file.text(); analyze(); } });
  $('parseProgram').addEventListener('click', () => analyze());
  $('stepProgram').addEventListener('click', () => { if (!parsedBlocks.length) analyze(); runBlock(); });
  $('resetProgram').addEventListener('click', () => { stop(); analyze(); });
  $('runProgram').addEventListener('click', () => {
    if (timer) { stop(); paused = true; refresh(); return; }
    if (!parsedBlocks.length || executed >= parsedBlocks.length) analyze();
    if (fatal) return;
    paused = false;
    $('runProgram').innerHTML = '<span>Ⅱ</span> 일시 정지';
    timer = setInterval(runBlock, 130);
  });
  $('gcodeInput').addEventListener('input', () => { stop(); parsedBlocks = []; executed = 0; warnings = []; fatal = ''; paused = false; resetStock(); $('canvasEmpty').classList.remove('hidden'); $('lineCount').textContent = 'EDITING'; $('programStatus').textContent = '코드 변경됨 · 분석을 다시 실행하세요.'; render(); const editedState = { phase: 'edited' }; window.__mctNcLinkState = editedState; window.dispatchEvent(new CustomEvent('mct:nc-link', { detail: editedState })); });
  ['stockX', 'stockY', 'stockZ', 'toolDiameter', 'toolTeeth', 'fluteLength', 'holderDiameter', 'toolOverhang', 'toolHNumber', 'toolLengthOffset', 'originX', 'originY', 'originZ', 'travelX', 'travelY', 'travelZ', 'maxRpm', 'maxRapid', 'viseJawWidth', 'viseOffset', 'viseHeight', 'viseEmbed', 'useFixture'].forEach(id => $(id).addEventListener('input', () => { if (parsedBlocks.length) analyze(); else render(); }));
  $('dialect').addEventListener('change', selectProfile);
  window.addEventListener('resize', render);
  analyze();
})();
