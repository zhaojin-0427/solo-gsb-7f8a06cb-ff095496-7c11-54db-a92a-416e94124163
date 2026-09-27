// annotations.js
// 注释（/Annots）印刷风险核验核心逻辑。
//
// 在「裁切与出血盒核验」同一次上传、同一份逐页报告中附带执行：
//   - 解析页面叶子字典的 /Annots（可整体为间接引用，数组元素也可间接引用），
//     逐条读取注释字典的 /Subtype、/Rect、/F（缺省 0）与 /AP/N；
//   - /Rect 必须是 4 个有限数且正面积，/F 必须是非负整数，/Subtype 必须是名称，
//     坏引用或任一字段非法时该条标为「无法判断」，不中断同页其他注释；
//   - /AP/N 为流时直接视为有效外观；为外观字典时必须由注释字典的 /AS
//     选中其中有效的流，缺少 /AS、选不中或选中的不是流均按外观损坏处理；
//   - 可见页框取继承的 CropBox（缺省 MediaBox）：有效矩形与页框无交集
//     （含仅相接、零面积相交）标为「页外」；
//   - 标志位按 PDF 规范：Hidden（位 2）同时取消屏显与打印（覆盖 Print），
//     NoView（位 5）只排除屏显、不取消打印；
//   - 设 Print（且未被 Hidden 覆盖）且有有效外观 → 打印候选；
//     设 Print 但外观缺失或损坏 → 待确认；
//     屏显候选但未设 Print → 漏印风险；其余为不显示不打印；
//   - 无 /Annots 的页显示「无注释」。
//
// 只核查 PDF 属性（标志位、外观字典、几何），不模拟任何渲染结果。
// 解析使用 pdf-lib 底层对象模型（PDFDict / PDFArray / PDFStream / PDFRef）。

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import { PT_PER_MM, mapPointToReading } from './bleedboxes.js';

// 注释标志位（PDF 1.7 表 165，/F 各位从 1 起）
export const ANNOT_FLAG = {
  INVISIBLE: 1 << 0, // 位 1
  HIDDEN: 1 << 1, // 位 2：强制不显示、不打印（覆盖 Print）
  PRINT: 1 << 2, // 位 3：打印
  NOZOOM: 1 << 3, // 位 4
  NOROTATE: 1 << 4, // 位 5
  NOVIEW: 1 << 5, // 位 6：不在屏幕显示（不影响打印）
  READONLY: 1 << 6, // 位 7
  LOCKED: 1 << 7, // 位 8
  TOGGLENOVIEW: 1 << 8, // 位 9
  LOCKEDCONTENTS: 1 << 9, // 位 10
};

// 单条注释判定
export const ANNOT_STATUS = {
  printOk: 'print-ok', // 打印候选（设 Print 且外观有效）
  printConfirm: 'print-confirm', // 待确认（设 Print 但外观缺失/损坏）
  screenRisk: 'screen-risk', // 漏印风险（屏显候选但未设 Print）
  offpage: 'offpage', // 页外（与可见页框无交集）
  inactive: 'inactive', // 不显示也不打印
  unknown: 'unknown', // 无法判断（坏引用/非法字段）
};

// 常见注释子类型中文名；未知名保留原名
const SUBTYPE_NAMES = {
  Text: '注释文本（Text）',
  Link: '链接（Link）',
  FreeText: '自由文本（FreeText）',
  Line: '直线（Line）',
  Square: '矩形（Square）',
  Circle: '圆（Circle）',
  Polygon: '多边形（Polygon）',
  PolyLine: '折线（PolyLine）',
  Highlight: '高亮（Highlight）',
  Underline: '下划线（Underline）',
  Squiggly: '波浪线（Squiggly）',
  StrikeOut: '删除线（StrikeOut）',
  Stamp: '图章（Stamp）',
  Caret: '脱字符（Caret）',
  Ink: '墨迹（Ink）',
  Popup: '弹出（Popup）',
  FileAttachment: '文件附件（FileAttachment）',
  Sound: '声音（Sound）',
  Movie: '影片（Movie）',
  Widget: '表单域（Widget）',
  PrinterMark: '印刷标记（PrinterMark）',
  TrapNet: '捕捉网（TrapNet）',
  Watermark: '水印（Watermark）',
  Redact: '涂销（Redact）',
  '3D': '3D（3D）',
};

/** @typedef {{x:number,y:number,x2:number,y2:number,width:number,height:number}} Rect */

/** 数组规整为矩形（pt）；非法返回 null，并给出原因。 */
function toRect(nums) {
  if (!Array.isArray(nums) || nums.length !== 4) return null;
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [x1, y1, x2, y2] = nums;
  const width = x2 - x1;
  const height = y2 - y1;
  if (!(width > 0) || !(height > 0)) return null;
  return { x: x1, y: y1, x2, y2, width, height };
}

/** 两矩形是否有正面积交集（仅相接不算）。 */
function hasPositiveIntersection(a, b) {
  return (
    Math.min(a.x2, b.x2) > Math.max(a.x, b.x) &&
    Math.min(a.y2, b.y2) > Math.max(a.y, b.y)
  );
}

function ptToMm(n) {
  return n / PT_PER_MM;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}

function refLabel(ref) {
  return ref instanceof PDFRef ? `${ref.objectNumber} ${ref.generationNumber} R` : null;
}

function nameText(pdfName) {
  try {
    return pdfName.decodeText();
  } catch {
    return String(pdfName);
  }
}

function rectUnrotatedMm(rect) {
  if (!rect) return null;
  return {
    x: round1(ptToMm(rect.x)),
    y: round1(ptToMm(rect.y)),
    width: round1(ptToMm(rect.width)),
    height: round1(ptToMm(rect.height)),
  };
}

/** 默认用户空间矩形映射到旋转后阅读方向（左上原点的左/上/宽/高，mm）。 */
function rectReadingMm(rect, rotation, media) {
  if (!rect || rotation === null || !media) return null;
  const corners = [
    mapPointToReading(rect.x, rect.y, rotation, media),
    mapPointToReading(rect.x2, rect.y, rotation, media),
    mapPointToReading(rect.x, rect.y2, rotation, media),
    mapPointToReading(rect.x2, rect.y2, rotation, media),
  ];
  const X1 = Math.min(...corners.map((c) => c.X));
  const X2 = Math.max(...corners.map((c) => c.X));
  const Y1 = Math.min(...corners.map((c) => c.Y));
  const Y2 = Math.max(...corners.map((c) => c.Y));
  return {
    left: round1(ptToMm(X1)),
    top: round1(ptToMm(Y1)),
    width: round1(ptToMm(X2 - X1)),
    height: round1(ptToMm(Y2 - Y1)),
  };
}

/**
 * 核验一页的 /Annots。
 * @param {import('pdf-lib').PDFPageLeaf} node 页面叶子字典
 * @param {{mediaBox:Rect|null, cropBox:Rect|null, rotation:(number|null)}} geom
 *        可见页框 = cropBox（缺省 MediaBox 时已由调用方传入 mediaBox）
 * @returns {object} 该页注释核验结果（挂到逐页报告的 annotations 字段）
 */
export function analyzePageAnnotations(node, geom) {
  const emptyCounts = () => ({
    total: 0,
    printOk: 0,
    printConfirm: 0,
    screenRisk: 0,
    offpage: 0,
    inactive: 0,
    unknown: 0,
  });

  let rawAnnots;
  try {
    // /Annots 不是可继承属性，只看页面叶子字典自身
    rawAnnots = node.get(PDFName.of('Annots'));
  } catch (err) {
    return {
      present: true,
      listValid: false,
      list: [],
      note: `读取 /Annots 失败：${err.message}，本页注释无法逐条核验。`,
      counts: emptyCounts(),
    };
  }
  if (rawAnnots === undefined) {
    // 无 /Annots 的页：无注释
    return {
      present: false,
      listValid: true,
      list: [],
      note: null,
      counts: emptyCounts(),
    };
  }

  const context = node.context;
  let annotsArray;
  try {
    annotsArray = context.lookup(rawAnnots);
  } catch {
    annotsArray = undefined;
  }
  if (!(annotsArray instanceof PDFArray)) {
    // /Annots 声明了但不是数组（或整体为无法解析的坏引用）
    return {
      present: true,
      listValid: false,
      list: [],
      note: '/Annots 不是数组（或引用无法解析），本页注释无法逐条核验。',
      counts: { ...emptyCounts(), unknown: 1 },
    };
  }

  const list = [];
  let size;
  try {
    size = annotsArray.size();
  } catch {
    return {
      present: true,
      listValid: false,
      list: [],
      note: '/Annots 数组无法遍历，本页注释无法逐条核验。',
      counts: { ...emptyCounts(), unknown: 1 },
    };
  }

  const counts = emptyCounts();
  const STATUS_TO_COUNT_KEY = {
    [ANNOT_STATUS.printOk]: 'printOk',
    [ANNOT_STATUS.printConfirm]: 'printConfirm',
    [ANNOT_STATUS.screenRisk]: 'screenRisk',
    [ANNOT_STATUS.offpage]: 'offpage',
    [ANNOT_STATUS.inactive]: 'inactive',
    [ANNOT_STATUS.unknown]: 'unknown',
  };

  const addRow = (row) => {
    list.push(row);
    const key = STATUS_TO_COUNT_KEY[row.status];
    if (key) counts[key] += 1;
    counts.total += 1;
  };

  for (let i = 0; i < size; i++) {
    let elementRaw;
    try {
      elementRaw = annotsArray.get(i);
    } catch (err) {
      addRow(unknownRow(i + 1, null, [`/Annots 第 ${i + 1} 项无法读取：${err.message}`]));
      continue;
    }
    const ref = refLabel(elementRaw);
    let dict;
    try {
      dict = context.lookup(elementRaw);
    } catch {
      dict = undefined;
    }
    if (dict === undefined) {
      addRow(
        unknownRow(i + 1, ref, ['/Annots 中的引用无法解析（坏引用）。'])
      );
      continue;
    }
    if (!(dict instanceof PDFDict)) {
      addRow(
        unknownRow(i + 1, ref, ['注释对象不是字典（/Annots 元素类型非法）。'])
      );
      continue;
    }
    addRow(analyzeAnnotationDict(dict, i + 1, ref, geom));
  }

  return {
    present: true,
    listValid: true,
    list,
    note: null,
    counts,
  };
}

function unknownRow(index, ref, reasons, extra = {}) {
  return {
    index,
    ref,
    subtype: null,
    subtypeName: '未知',
    positionMm: null,
    positionUnrotatedMm: null,
    outsidePage: false,
    flags: null,
    screen: null,
    print: null,
    appearance: null,
    status: ANNOT_STATUS.unknown,
    reasons,
    ...extra,
  };
}

/**
 * 逐条解析注释字典并判定屏显/打印状态。任何字段异常只影响本条（unknown）。
 */
function analyzeAnnotationDict(dict, index, ref, geom) {
  const reasons = [];

  // ---- /Subtype（必须为名称）----
  let subtypeRaw;
  try {
    subtypeRaw = dict.get(PDFName.of('Subtype'));
  } catch {
    subtypeRaw = undefined;
  }
  let subtypeResolved = subtypeRaw;
  if (subtypeRaw instanceof PDFRef) {
    try {
      subtypeResolved = dict.context.lookup(subtypeRaw);
    } catch {
      subtypeResolved = undefined;
    }
  }
  let subtype = null;
  if (subtypeResolved instanceof PDFName) {
    subtype = nameText(subtypeResolved);
  } else {
    reasons.push('/Subtype 缺失或不是名称对象。');
  }

  // ---- /Rect（4 个有限数且正面积）----
  let rect = null;
  let rectProblem = null;
  let rectRaw;
  try {
    rectRaw = dict.get(PDFName.of('Rect'));
  } catch {
    rectRaw = undefined;
  }
  if (rectRaw === undefined) {
    rectProblem = '缺少 /Rect。';
  } else {
    let rectArray;
    try {
      rectArray = dict.context.lookup(rectRaw);
    } catch {
      rectArray = undefined;
    }
    if (!(rectArray instanceof PDFArray)) {
      rectProblem = '/Rect 不是数组。';
    } else {
      const nums = [];
      try {
        if (rectArray.size() !== 4) {
          rectProblem = '/Rect 不是 4 个数字。';
        } else {
          for (let k = 0; k < 4; k++) {
            const numObj = rectArray.lookupMaybe(k, PDFNumber);
            if (!numObj) {
              rectProblem = '/Rect 含有非数字元素。';
              break;
            }
            nums.push(numObj.asNumber());
          }
          if (!rectProblem) {
            if (!nums.every((n) => Number.isFinite(n))) {
              rectProblem = '/Rect 含有非有限数。';
            } else {
              rect = toRect(nums);
              if (!rect) rectProblem = '/Rect 宽高不为正（零面积或反向矩形）。';
            }
          }
        }
      } catch {
        rectProblem = '/Rect 读取失败。';
      }
    }
  }
  if (rectProblem) reasons.push(rectProblem);

  // ---- /F（非负整数；缺省 0）----
  let flagsInfo = null;
  let flagsInvalid = false;
  let fRaw;
  try {
    fRaw = dict.get(PDFName.of('F'));
  } catch {
    fRaw = undefined;
  }
  if (fRaw === undefined) {
    flagsInfo = { value: 0, defaulted: true, invalid: false };
  } else {
    let fResolved = fRaw;
    if (fRaw instanceof PDFRef) {
      try {
        fResolved = dict.context.lookup(fRaw);
      } catch {
        fResolved = undefined;
      }
    }
    if (!(fResolved instanceof PDFNumber)) {
      flagsInvalid = true;
      reasons.push('/F 不是整数（标志位必须为非负整数，缺省应为 0）。');
    } else {
      const value = fResolved.asNumber();
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        flagsInvalid = true;
        reasons.push('/F 不是非负整数（标志位必须为非负整数，缺省应为 0）。');
      } else {
        flagsInfo = { value, defaulted: false, invalid: false };
      }
    }
  }

  // 非法字段：本条无法判断（仍尽力带上已读到的子类型/位置）
  if (subtype === null || rect === null || flagsInvalid) {
    return unknownRow(index, ref, reasons, {
      subtype,
      subtypeName: subtype ? subtypeLabel(subtype) : '未知',
      positionMm: rect ? safeReading(rect, geom) : null,
      positionUnrotatedMm: rectUnrotatedMm(rect),
    });
  }

  // ---- 标志位语义 ----
  const f = flagsInfo.value;
  const hidden = (f & ANNOT_FLAG.HIDDEN) !== 0;
  const noView = (f & ANNOT_FLAG.NOVIEW) !== 0;
  const printRequested = (f & ANNOT_FLAG.PRINT) !== 0;
  // Hidden 覆盖 Print；NoView 只排除屏显
  const screenCandidate = !hidden && !noView;
  const printCandidate = printRequested && !hidden;

  const screen = {
    candidate: screenCandidate,
    note: screenCandidate
      ? '未设 Hidden / NoView：注释可在屏幕显示。'
      : hidden
        ? 'F 含 Hidden（位 2）：强制不在屏幕显示。'
        : 'F 含 NoView（位 6）：不在屏幕显示。',
  };
  const print = {
    candidate: printCandidate,
    requested: printRequested,
    note: !printRequested
      ? '未设 Print（位 3）：不参与打印。'
      : hidden
        ? 'F 含 Print，但 Hidden 覆盖 Print：不打印。'
        : 'F 含 Print（位 3）：参与打印。',
  };

  // ---- /AP/N 外观 ----
  const appearance = readAppearance(dict);
  if (appearance.status === 'broken') reasons.push(appearance.detail);
  else if (appearance.status === 'missing') reasons.push(appearance.detail);

  // ---- 页外判定（与继承 CropBox/缺省 MediaBox 求交）----
  let outsidePage = false;
  const visibleBox = geom.cropBox || geom.mediaBox || null;
  if (!visibleBox) {
    reasons.push('可见页框（CropBox / MediaBox）无效，未做页外判定。');
  } else if (!hasPositiveIntersection(rect, visibleBox)) {
    outsidePage = true;
    reasons.push('矩形与可见页框（继承 CropBox，缺省 MediaBox）无交集，标为页外。');
  }

  // ---- 综合判定 ----
  let status;
  if (outsidePage) {
    status = ANNOT_STATUS.offpage;
  } else if (printCandidate) {
    if (appearance.status === 'ok') {
      status = ANNOT_STATUS.printOk;
      reasons.push('已设 Print 且 /AP/N 外观有效：打印候选。');
    } else {
      status = ANNOT_STATUS.printConfirm;
      reasons.push('已设 Print，但外观缺失或损坏：打印效果待确认。');
    }
  } else if (screenCandidate) {
    status = ANNOT_STATUS.screenRisk;
    if (!printRequested) {
      reasons.push('屏幕可见但未设 Print：存在漏印风险。');
    }
  } else {
    status = ANNOT_STATUS.inactive;
    if (hidden) reasons.push('Hidden 同时取消屏显与打印。');
    else if (noView) reasons.push('NoView 仅排除屏显，且未设 Print：不会打印。');
    else reasons.push('缺省标志（F=0）：不显示也不打印。');
  }

  return {
    index,
    ref,
    subtype,
    subtypeName: subtypeLabel(subtype),
    positionMm: safeReading(rect, geom),
    positionUnrotatedMm: rectUnrotatedMm(rect),
    outsidePage,
    flags: {
      ...flagsInfo,
      hidden,
      noView,
      printRequested,
    },
    screen,
    print,
    appearance,
    status,
    reasons,
  };
}

function safeReading(rect, geom) {
  try {
    return rectReadingMm(rect, geom.rotation ?? null, geom.mediaBox ?? null);
  } catch {
    return null;
  }
}

function subtypeLabel(subtype) {
  return SUBTYPE_NAMES[subtype] || `${subtype}（未知名）`;
}

/**
 * 读取 /AP/N：
 *   - N 直接为流：有效外观；
 *   - N 为字典：由注释字典 /AS 选中其中有效流；
 *   - 缺失 / 坏引用 / /AS 选不中 / 选中非流：missing 或 broken。
 */
function readAppearance(dict) {
  const bad = (detail) => ({ status: 'broken', source: null, asName: null, detail });
  const missing = (detail) => ({ status: 'missing', source: null, asName: null, detail });
  const ok = (source, asName, detail) => ({ status: 'ok', source, asName, detail });

  let apRaw;
  try {
    apRaw = dict.get(PDFName.of('AP'));
  } catch {
    apRaw = undefined;
  }
  if (apRaw === undefined) {
    return missing('缺少 /AP/N：注释没有外观（查看器可能自行生成外观）。');
  }
  let ap;
  try {
    ap = dict.context.lookup(apRaw);
  } catch {
    ap = undefined;
  }
  if (!(ap instanceof PDFDict)) {
    return bad('/AP 不是字典（或引用无法解析），外观损坏。');
  }

  let nRaw;
  try {
    nRaw = ap.get(PDFName.of('N'));
  } catch {
    nRaw = undefined;
  }
  if (nRaw === undefined) {
    return missing('/AP 中缺少 N：没有正常外观。');
  }
  let nObj;
  try {
    nObj = dict.context.lookup(nRaw);
  } catch {
    nObj = undefined;
  }
  if (nObj === undefined) {
    return bad('/AP/N 引用无法解析（坏引用），外观损坏。');
  }
  if (nObj instanceof PDFStream) {
    return ok('stream', null, '/AP/N 直接为外观流。');
  }
  if (!(nObj instanceof PDFDict)) {
    return bad('/AP/N 既不是流也不是外观字典，外观损坏。');
  }

  // N 为外观字典：必须由注释字典的 /AS 选中有效流
  let asRaw;
  try {
    asRaw = dict.get(PDFName.of('AS'));
  } catch {
    asRaw = undefined;
  }
  let asNameObj = asRaw;
  if (asRaw instanceof PDFRef) {
    try {
      asNameObj = dict.context.lookup(asRaw);
    } catch {
      asNameObj = undefined;
    }
  }
  if (!(asNameObj instanceof PDFName)) {
    return bad('/AP/N 为外观字典，但缺少有效的 /AS 名称，无法选中外观流，外观损坏。');
  }
  const asName = nameText(asNameObj);
  let selectedRaw;
  try {
    selectedRaw = nObj.get(PDFName.of(asName));
  } catch {
    selectedRaw = undefined;
  }
  if (selectedRaw === undefined) {
    return bad(`/AP/N 外观字典中没有 /AS=${asName} 对应的条目，外观损坏。`);
  }
  let selected;
  try {
    selected = dict.context.lookup(selectedRaw);
  } catch {
    selected = undefined;
  }
  if (!(selected instanceof PDFStream)) {
    return bad(`/AS=${asName} 选中的对象不是流，外观损坏。`);
  }
  return ok('as', asName, `/AP/N 为外观字典，/AS=${asName} 选中有效外观流。`);
}
