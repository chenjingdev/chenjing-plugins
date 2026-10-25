import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

// PNG chunk framing and CRC: https://www.w3.org/TR/png-3/
function completePng(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG)) return false;
  let position = 8, header = false, data = false, palette = false, color;
  while (position + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(position);
    const end = position + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) return false;
    const type = bytes.toString('ascii', position + 4, position + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(position + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    if (!header && type !== 'IHDR') return false;
    if (type === 'IHDR') {
      if (header || length !== 13) return false;
      const width = bytes.readUInt32BE(position + 8), height = bytes.readUInt32BE(position + 12);
      color = bytes[position + 17];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[color]?.includes(bytes[position + 16])) return false;
      if (bytes[position + 18] !== 0 || bytes[position + 19] !== 0 || bytes[position + 20] > 1) return false;
      header = true;
    } else if (type === 'PLTE') {
      if (!length || length % 3 || length > 768 || data) return false;
      palette = true;
    } else if (type === 'IDAT') {
      if (color === 3 && !palette) return false;
      data ||= length > 0;
    } else if (type === 'IEND') {
      return length === 0 && header && data && end === bytes.length;
    } else if (type[0] === type[0].toUpperCase()) return false;
    position = end;
  }
  return false;
}

// Check JPEG marker/segment completeness; this does not decode the image pixels.
function completeJpeg(bytes) {
  if (bytes.length < 20 || bytes[0] !== 255 || bytes[1] !== 216) return false;
  let position = 2, frame = false, scan = false, entropy = 0;
  while (position < bytes.length) {
    if (bytes[position++] !== 255) return false;
    while (bytes[position] === 255) position++;
    const marker = bytes[position++];
    if (marker === 217) return frame && scan && entropy > 0 && position === bytes.length;
    if (marker === undefined || marker === 0 || marker === 216) return false;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (position + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(position);
    const end = position + length;
    if (length < 2 || end > bytes.length) return false;
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (length < 8 || !bytes.readUInt16BE(position + 3) || !bytes.readUInt16BE(position + 5)) return false;
      const components = bytes[position + 7];
      if (!components || length !== 8 + 3 * components) return false;
      frame = true;
    }
    if (marker === 218) {
      const components = bytes[position + 2];
      if (!frame || length < 8 || !components || length !== 6 + 2 * components) return false;
      scan = true;
      position = end;
      while (position < bytes.length) {
        if (bytes[position] !== 255) { entropy++; position++; continue; }
        let next = position + 1;
        while (bytes[next] === 255) next++;
        const value = bytes[next];
        if (value === 0) { entropy++; position = next + 1; continue; }
        if (value >= 208 && value <= 215) { position = next + 1; continue; }
        break;
      }
    } else position = end;
  }
  return false;
}

export function screenshotIssue(shot, runDir) {
  if (typeof shot !== 'string' || !shot.trim()) return '스크린샷 경로가 없습니다';
  if (path.isAbsolute(shot)) return '스크린샷은 실행 폴더 안의 상대 경로여야 합니다';
  const root = realpathSync(runDir);
  const file = path.resolve(root, shot);
  if (!inside(root, file)) return '스크린샷 경로가 실행 폴더 밖입니다';
  if (!existsSync(file)) return '스크린샷 파일이 없습니다';
  const resolved = realpathSync(file);
  if (!inside(root, resolved)) return '스크린샷의 실제 경로가 실행 폴더 밖입니다';
  if (!statSync(resolved).isFile()) return '스크린샷 경로가 파일이 아닙니다';
  const bytes = readFileSync(resolved);
  if (!completePng(bytes) && !completeJpeg(bytes)) return '스크린샷이 비어 있거나 완결된 PNG/JPEG 형식이 아닙니다';
  return null;
}

export function evidenceIssues(step, { runDir, surface } = {}) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return ['검수 단계가 올바르지 않습니다'];
  const issues = [];
  if (typeof step.action !== 'string' || !step.action.trim()) issues.push('검수 단계의 동작 설명이 없습니다');
  const mode = surface ?? (step.shot ? 'ui' : 'command');
  if (mode === 'ui') {
    try {
      const issue = screenshotIssue(step.shot, runDir);
      if (issue) issues.push(issue);
    } catch (error) {
      issues.push(`스크린샷을 확인할 수 없습니다: ${error.message}`);
    }
  } else if (mode === 'command') {
    if (typeof step.output !== 'string') issues.push('명령 출력이 없습니다');
    // 종료 코드의 값은 보지 않는다. 오류를 확인하는 케이스는 0이 아닌 코드가 정답이다. 통과·실패 판정은 verifier가 result에 적는다.
    if (!Number.isInteger(step.exitCode)) issues.push('명령 종료 코드가 없습니다');
  } else {
    issues.push('검수 방식은 ui 또는 command여야 합니다');
  }
  return issues;
}

export function effectiveResult(scenario, options) {
  if (scenario?.result === 'fail') return 'fail';
  if (!['pass', 'doubt'].includes(scenario?.result)) return 'unverified';
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) return 'unverified';
  if (scenario.steps.some(step => evidenceIssues(step, options).length > 0)) return 'unverified';
  return scenario.result;
}
