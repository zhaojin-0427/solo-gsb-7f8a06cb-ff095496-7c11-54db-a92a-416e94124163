// test/annotations.test.js
// 注释印刷风险核验：构造带 /Annots 的测试 PDF，验证字段解析、
// 标志位（Print/Hidden/NoView）、外观（流 / 字典 + /AS）、页外交集、
// 坏引用与非法字段隔离，以及多页汇总。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
} from 'pdf-lib';
import {
  checkBleedBoxes,
  PAGE_STATUS,
  PT_PER_MM,
} from '../bleedboxes.js';
import { ANNOT_FLAG, ANNOT_STATUS } from '../annotations.js';

const mm = (v) => v * PT_PER_MM;

function box(ctx, vals) {
  const a = PDFArray.withContext(ctx);
  for (const v of vals) a.push(PDFNumber.of(v));
  return a;
}

const DEFAULT_OPTS = {
  finishedWidthMm: 210,
  finishedHeightMm: 297,
  minBleedMm: 3,
};

/**
 * 构造单页 PDF，annotSpecs 为注释构造器列表。
 * spec: { subtype?, rect?, flags?, ap?, as?, indirect?, brokenAnnotsRef?, badAnnots?,
 *         indirectRect?, inheritedCrop? }
 */
async function buildPdf(annotSpecs = [], pageOpts = {}) {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const W = mm(210);
  const H = mm(297);
  const page = doc.addPage([W, H]);
  const node = page.node;
  const ctx = doc.context;

  if (pageOpts.crop) {
    node.set(PDFName.of('CropBox'), box(ctx, pageOpts.crop));
  }
  if (typeof pageOpts.rotate === 'number') {
    node.set(PDFName.of('Rotate'), PDFNumber.of(pageOpts.rotate));
  }

  if (pageOpts.noAnnots) {
    if (pageOpts.badAnnotsType === 'number') {
      node.set(PDFName.of('Annots'), PDFNumber.of(7));
    } else if (pageOpts.badAnnotsType === 'dangling') {
      node.set(PDFName.of('Annots'), PDFRef.of(99999, 0));
    }
    return doc.save();
  }

  const arr = PDFArray.withContext(ctx);
  for (const spec of annotSpecs) {
    const a = buildAnnotation(ctx, spec);
    if (spec.indirect) {
      const ref = ctx.register(a);
      arr.push(ref);
    } else {
      arr.push(a);
    }
  }

  let annotsToSet = arr;
  if (pageOpts.indirectAnnots) {
    annotsToSet = ctx.register(arr);
  }
  node.set(PDFName.of('Annots'), annotsToSet);
  return doc.save();
}

/** 构造一个外观流（内容任意，只要对象是 PDFStream）。 */
function makeStream(ctx, dictExtra = {}) {
  const dict = PDFDict.withContext(ctx);
  dict.set(PDFName.of('Type'), PDFName.of('XObject'));
  dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
  dict.set(
    PDFName.of('BBox'),
    box(ctx, [0, 0, 10, 10])
  );
  for (const [k, v] of Object.entries(dictExtra)) dict.set(PDFName.of(k), v);
  return PDFRawStream.of(dict, new Uint8Array([0, 0]));
}

/** 按 spec 构造注释字典。 */
function buildAnnotation(ctx, spec) {
  const d = PDFDict.withContext(ctx);
  d.set(PDFName.of('Type'), PDFName.of('Annot'));
  if (spec.subtype !== null) {
    d.set(PDFName.of('Subtype'), PDFName.of(spec.subtype || 'Text'));
  }
  if (spec.badSubtype) d.set(PDFName.of('Subtype'), PDFNumber.of(5));

  if (spec.rect !== undefined) {
    const rectArr = box(ctx, spec.rect);
    if (spec.indirectRect) d.set(PDFName.of('Rect'), ctx.register(rectArr));
    else d.set(PDFName.of('Rect'), rectArr);
  }
  if (spec.badRectType) d.set(PDFName.of('Rect'), PDFNumber.of(1));
  if (spec.badRectValues) d.set(PDFName.of('Rect'), box(ctx, spec.badRectValues));

  if (typeof spec.flags === 'number') {
    d.set(PDFName.of('F'), PDFNumber.of(spec.flags));
  }
  if (spec.badFlags === 'negative') d.set(PDFName.of('F'), PDFNumber.of(-1));
  if (spec.badFlags === 'type') d.set(PDFName.of('F'), PDFName.of('X'));

  // /AP 外观
  if (spec.ap === 'stream') {
    const ap = PDFDict.withContext(ctx);
    ap.set(PDFName.of('N'), ctx.register(makeStream(ctx)));
    d.set(PDFName.of('AP'), ap);
  } else if (spec.ap === 'directStream') {
    const ap = PDFDict.withContext(ctx);
    ap.set(PDFName.of('N'), makeStream(ctx));
    d.set(PDFName.of('AP'), ap);
  } else if (spec.ap === 'dict') {
    const n = PDFDict.withContext(ctx);
    n.set(PDFName.of('On'), ctx.register(makeStream(ctx)));
    n.set(PDFName.of('Off'), ctx.register(makeStream(ctx)));
    n.set(PDFName.of('Bad'), PDFNumber.of(3));
    const ap = PDFDict.withContext(ctx);
    ap.set(PDFName.of('N'), n);
    d.set(PDFName.of('AP'), ap);
    d.set(PDFName.of('AS'), PDFName.of(spec.as || 'On'));
  } else if (spec.ap === 'dictMissingAS') {
    const n = PDFDict.withContext(ctx);
    n.set(PDFName.of('On'), ctx.register(makeStream(ctx)));
    const ap = PDFDict.withContext(ctx);
    ap.set(PDFName.of('N'), n);
    d.set(PDFName.of('AP'), ap);
  } else if (spec.ap === 'dictBadAS') {
    const n = PDFDict.withContext(ctx);
    n.set(PDFName.of('On'), ctx.register(makeStream(ctx)));
    const ap = PDFDict.withContext(ctx);
    ap.set(PDFName.of('N'), n);
    d.set(PDFName.of('AP'), ap);
    d.set(PDFName.of('AS'), PDFName.of('Nope'));
  } else if (spec.ap === 'brokenStreamRef') {
    const ap = PDFDict.withContext(ctx);
    ap.set(PDFName.of('N'), PDFRef.of(99998, 0));
    d.set(PDFName.of('AP'), ap);
  } else if (spec.ap === 'wrongType') {
    const ap = PDFDict.withContext(ctx);
    ap.set(PDFName.of('N'), PDFNumber.of(9));
    d.set(PDFName.of('AP'), ap);
  }

  return d;
}

async function checkFirstPage(specs, pageOpts) {
  const bytes = await buildPdf(specs, pageOpts);
  const report = await checkBleedBoxes(Buffer.from(bytes), DEFAULT_OPTS);
  return report.pages[0];
}

async function checkFull(specs, pageOpts) {
  const bytes = await buildPdf(specs, pageOpts);
  return checkBleedBoxes(Buffer.from(bytes), DEFAULT_OPTS);
}

const IN_RECT = [mm(10), mm(10), mm(60), mm(20)];

// ---- 无注释页 ----

test('无 /Annots 的页：显示无注释，不计任何状态', async () => {
  const pg = await checkFirstPage([], { noAnnots: true });
  assert.equal(pg.annotations.present, false);
  assert.equal(pg.annotations.list.length, 0);
  assert.equal(pg.annotations.counts.total, 0);
  // 盒核验仍正常
  assert.equal(pg.status, PAGE_STATUS.undeclared);
});

test('/Annots 为空数组：有 /Annots 但 0 条', async () => {
  const pg = await checkFirstPage([]);
  assert.equal(pg.annotations.present, true);
  assert.equal(pg.annotations.counts.total, 0);
});

// ---- 字段解析与缺省 ----

test('/F 缺省为 0；无 AP：屏显可见但不打印 → 漏印风险', async () => {
  const pg = await checkFirstPage([{ subtype: 'Highlight', rect: IN_RECT }]);
  const a = pg.annotations.list[0];
  assert.equal(a.status, ANNOT_STATUS.screenRisk);
  assert.equal(a.flags.defaulted, true);
  assert.equal(a.flags.value, 0);
  assert.equal(a.screen.candidate, true);
  assert.equal(a.print.candidate, false);
  assert.equal(a.appearance.status, 'missing');
  assert.equal(a.subtypeName.includes('高亮'), true);
});

test('位置以毫米给出：旋转后阅读方向左/上与宽高', async () => {
  // 未旋转：rect 左下角 (10mm,10mm)，50×10mm；页面高 297mm
  const pg = await checkFirstPage([{ subtype: 'Text', rect: IN_RECT }]);
  const p = pg.annotations.list[0].positionMm;
  assert.ok(Math.abs(p.left - 10) < 0.05, JSON.stringify(p));
  // 未旋转：阅读上边 = 页高 297 − 未旋转顶 20 = 277
  assert.ok(Math.abs(p.top - 277) < 0.05, JSON.stringify(p));
  assert.ok(Math.abs(p.width - 50) < 0.05);
  assert.ok(Math.abs(p.height - 10) < 0.05);
});

test('Rotate=90 时位置按阅读方向旋转输出', async () => {
  const pg = await checkFirstPage(
    [{ subtype: 'Text', rect: [mm(10), mm(10), mm(20), mm(60)] }],
    { rotate: 90 }
  );
  const p = pg.annotations.list[0].positionMm;
  // 90°CW：阅读左 = 未旋转下 10；阅读上 = 未旋转左 10；宽=50（y 跨），高=10（x 跨）
  assert.ok(Math.abs(p.left - 10) < 0.05, JSON.stringify(p));
  assert.ok(Math.abs(p.top - 10) < 0.05, JSON.stringify(p));
  assert.ok(Math.abs(p.width - 50) < 0.05);
  assert.ok(Math.abs(p.height - 10) < 0.05);
});

test('/Rect 可为间接引用；元素可为间接注释字典', async () => {
  const pg = await checkFirstPage(
    [
      {
        subtype: 'Text',
        rect: IN_RECT,
        flags: ANNOT_FLAG.PRINT,
        ap: 'stream',
        indirect: true,
        indirectRect: true,
      },
    ]
  );
  assert.equal(pg.annotations.list[0].status, ANNOT_STATUS.printOk);
  assert.equal(typeof pg.annotations.list[0].ref, 'string'); // 间接对象号
});

test('/Annots 整体为间接引用也能解析', async () => {
  const pg = await checkFirstPage(
    [{ subtype: 'Text', rect: IN_RECT, flags: ANNOT_FLAG.PRINT, ap: 'stream' }],
    { indirectAnnots: true }
  );
  assert.equal(pg.annotations.list[0].status, ANNOT_STATUS.printOk);
});

// ---- 打印候选 / 待确认 ----

test('Print + 直接流外观：打印候选', async () => {
  const pg = await checkFirstPage(
    [{ subtype: 'Stamp', rect: IN_RECT, flags: ANNOT_FLAG.PRINT, ap: 'stream' }]
  );
  const a = pg.annotations.list[0];
  assert.equal(a.status, ANNOT_STATUS.printOk);
  assert.equal(a.appearance.source, 'stream');
  assert.equal(a.print.note.includes('Print'), true);
});

test('Print + /AP/N 内联流（非间接）也有效', async () => {
  const pg = await checkFirstPage(
    [{ subtype: 'Text', rect: IN_RECT, flags: ANNOT_FLAG.PRINT, ap: 'directStream' }]
  );
  assert.equal(pg.annotations.list[0].status, ANNOT_STATUS.printOk);
});

test('Print 但无 /AP：外观缺失 → 待确认', async () => {
  const pg = await checkFirstPage(
    [{ subtype: 'Link', rect: IN_RECT, flags: ANNOT_FLAG.PRINT }]
  );
  const a = pg.annotations.list[0];
  assert.equal(a.status, ANNOT_STATUS.printConfirm);
  assert.equal(a.appearance.status, 'missing');
  assert.ok(a.reasons.join(' ').includes('待确认'));
});

test('Print + N 字典 + /AS=On 选中流：打印候选；坏引用流 → 待确认', async () => {
  const pg = await checkFirstPage([
    { subtype: 'Widget', rect: IN_RECT, flags: ANNOT_FLAG.PRINT, ap: 'dict', as: 'On' },
    {
      subtype: 'Widget',
      rect: IN_RECT,
      flags: ANNOT_FLAG.PRINT,
      ap: 'brokenStreamRef',
    },
  ]);
  assert.equal(pg.annotations.list[0].status, ANNOT_STATUS.printOk);
  assert.equal(pg.annotations.list[0].appearance.asName, 'On');
  assert.equal(pg.annotations.list[1].status, ANNOT_STATUS.printConfirm);
  assert.equal(pg.annotations.list[1].appearance.status, 'broken');
});

test('N 为字典但缺 /AS 或 /AS 选不中或选中非流：外观损坏 → 待确认', async () => {
  const pg = await checkFirstPage([
    { subtype: 'Widget', rect: IN_RECT, flags: ANNOT_FLAG.PRINT, ap: 'dictMissingAS' },
    { subtype: 'Widget', rect: IN_RECT, flags: ANNOT_FLAG.PRINT, ap: 'dictBadAS' },
    { subtype: 'Text', rect: IN_RECT, flags: ANNOT_FLAG.PRINT, ap: 'wrongType' },
  ]);
  for (const a of pg.annotations.list) {
    assert.equal(a.status, ANNOT_STATUS.printConfirm);
    assert.equal(a.appearance.status, 'broken');
  }
});

// ---- Hidden / NoView ----

test('Hidden 覆盖 Print：即便有外观与 Print 也不打印；NoView 只排除屏显', async () => {
  const pg = await checkFirstPage([
    {
      subtype: 'Text',
      rect: IN_RECT,
      flags: ANNOT_FLAG.PRINT | ANNOT_FLAG.HIDDEN,
      ap: 'stream',
    },
    {
      subtype: 'Text',
      rect: IN_RECT,
      flags: ANNOT_FLAG.PRINT | ANNOT_FLAG.NOVIEW,
      ap: 'stream',
    },
    {
      subtype: 'Text',
      rect: IN_RECT,
      flags: ANNOT_FLAG.NOVIEW,
      ap: 'stream',
    },
  ]);
  const [hidden, noViewPrint, noViewOnly] = pg.annotations.list;
  assert.equal(hidden.status, ANNOT_STATUS.inactive);
  assert.equal(hidden.screen.candidate, false);
  assert.equal(hidden.print.candidate, false);
  assert.ok(hidden.print.note.includes('Hidden'));

  assert.equal(noViewPrint.status, ANNOT_STATUS.printOk);
  assert.equal(noViewPrint.screen.candidate, false);
  assert.equal(noViewPrint.print.candidate, true);

  assert.equal(noViewOnly.status, ANNOT_STATUS.inactive);
  assert.equal(noViewOnly.screen.candidate, false);
  assert.equal(noViewOnly.print.candidate, false);
});

test('仅 NoView、无外观且未设 Print：不判为漏印风险（屏显非候选）', async () => {
  const pg = await checkFirstPage(
    [{ subtype: 'Text', rect: IN_RECT, flags: ANNOT_FLAG.NOVIEW }]
  );
  assert.equal(pg.annotations.list[0].status, ANNOT_STATUS.inactive);
});

// ---- 页外 ----

test('矩形与可见页框无交集：页外（Print 候选也归页外）', async () => {
  const pg = await checkFirstPage([
    { subtype: 'Text', rect: [mm(300), mm(400), mm(310), mm(410)], flags: ANNOT_FLAG.PRINT, ap: 'stream' },
  ]);
  const a = pg.annotations.list[0];
  assert.equal(a.status, ANNOT_STATUS.offpage);
  assert.equal(a.outsidePage, true);
  assert.ok(a.reasons.join(' ').includes('无交集'));
});

test('仅边相接（零面积交集）也算页外；进入 CropBox 内则不是', async () => {
  const pg = await checkFirstPage(
    [
      // x 从 210mm 起：与页面右边仅相接
      { subtype: 'Text', rect: [mm(210), mm(10), mm(220), mm(20)] },
      // 落在页面内
      { subtype: 'Text', rect: [mm(5), mm(5), mm(205), mm(290)] },
    ],
    { crop: [0, 0, mm(210), mm(297)] }
  );
  assert.equal(pg.annotations.list[0].status, ANNOT_STATUS.offpage);
  assert.notEqual(pg.annotations.list[1].status, ANNOT_STATUS.offpage);
});

test('CropBox 裁切可见页框：MediaBox 内但 CropBox 外的注释标页外', async () => {
  const pg = await checkFirstPage(
    [{ subtype: 'Text', rect: [mm(180), mm(10), mm(200), mm(20)] }],
    { crop: [0, 0, mm(150), mm(297)] }
  );
  assert.equal(pg.annotations.list[0].status, ANNOT_STATUS.offpage);
});

// ---- 非法字段 / 坏引用隔离 ----

test('非法 /Subtype / /Rect / /F 标为无法判断，不中断其他注释', async () => {
  const pg = await checkFirstPage([
    { subtype: 'Text', rect: IN_RECT, badSubtype: true },
    { subtype: 'Text', rect: IN_RECT, badRectType: true },
    { subtype: 'Text', rect: IN_RECT, badRectValues: [0, 0, 0, mm(10)] },
    { subtype: 'Text', rect: IN_RECT },
    { subtype: 'Text', rect: IN_RECT, badFlags: 'negative' },
    { subtype: 'Text', rect: IN_RECT, badFlags: 'type' },
    { subtype: null, rect: IN_RECT }, // 缺 Subtype
    { subtype: 'Text' }, // 缺 Rect
  ]);
  const list = pg.annotations.list;
  assert.equal(list[0].status, ANNOT_STATUS.unknown);
  assert.equal(list[1].status, ANNOT_STATUS.unknown);
  assert.equal(list[2].status, ANNOT_STATUS.unknown); // 零面积
  assert.equal(list[3].status, ANNOT_STATUS.screenRisk); // 合法注释仍正常
  assert.equal(list[4].status, ANNOT_STATUS.unknown);
  assert.equal(list[5].status, ANNOT_STATUS.unknown);
  assert.equal(list[6].status, ANNOT_STATUS.unknown);
  assert.equal(list[7].status, ANNOT_STATUS.unknown);
  assert.equal(pg.annotations.counts.unknown, 7);
});

test('/Rect 含 Infinity（非有限数）：无法判断（直接在内存对象上核验，不经过保存）', async () => {
  const { analyzePageAnnotations } = await import('../annotations.js');
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage([mm(210), mm(297)]);
  const d = PDFDict.withContext(ctx);
  d.set(PDFName.of('Subtype'), PDFName.of('Text'));
  const r = PDFArray.withContext(ctx);
  [0, 0, 10, Infinity].forEach((v) => r.push(PDFNumber.of(v)));
  d.set(PDFName.of('Rect'), r);
  const arr = PDFArray.withContext(ctx);
  arr.push(d);
  page.node.set(PDFName.of('Annots'), arr);
  const res = analyzePageAnnotations(page.node, {
    mediaBox: { x: 0, y: 0, x2: mm(210), y2: mm(297), width: mm(210), height: mm(297) },
    cropBox: { x: 0, y: 0, x2: mm(210), y2: mm(297), width: mm(210), height: mm(297) },
    rotation: 0,
  });
  assert.equal(res.list[0].status, ANNOT_STATUS.unknown);
  assert.ok(res.list[0].reasons.join(' ').includes('有限'));
});

test('坏引用数组元素与 /Annots 整体坏引用：不崩溃，分别处理', async () => {
  const bytesDanglingElement = await buildPdf([]);
  // 手工插入一个悬空引用到 /Annots
  const { PDFDocument } = await import('pdf-lib');
  let doc = await PDFDocument.load(bytesDanglingElement);
  let node = doc.getPages()[0].node;
  const arr = PDFArray.withContext(doc.context);
  arr.push(PDFRef.of(99997, 0));
  arr.push(PDFNumber.of(42)); // 非字典元素
  // 再加一条合法注释
  const d = PDFDict.withContext(doc.context);
  d.set(PDFName.of('Subtype'), PDFName.of('Text'));
  const r = PDFArray.withContext(doc.context);
  [mm(10), mm(10), mm(20), mm(20)].forEach((v) => r.push(PDFNumber.of(v)));
  d.set(PDFName.of('Rect'), r);
  arr.push(d);
  node.set(PDFName.of('Annots'), arr);
  const fixedBytes = await doc.save();
  const report = await checkBleedBoxes(Buffer.from(fixedBytes), DEFAULT_OPTS);
  const list = report.pages[0].annotations.list;
  assert.equal(list[0].status, ANNOT_STATUS.unknown); // 坏引用
  assert.ok(list[0].reasons.join(' ').includes('坏引用'));
  assert.equal(list[1].status, ANNOT_STATUS.unknown); // 非字典
  assert.equal(list[2].status, ANNOT_STATUS.screenRisk); // 合法条目不受影响

  const pg2 = await checkFirstPage([], { noAnnots: true, badAnnotsType: 'dangling' });
  assert.equal(pg2.annotations.listValid, false);
  assert.equal(pg2.annotations.counts.unknown, 1);

  const pg3 = await checkFirstPage([], { noAnnots: true, badAnnotsType: 'number' });
  assert.equal(pg3.annotations.listValid, false);
});

// ---- 汇总 ----

test('逐页汇总漏印风险页、待确认页与条数', async () => {
  // 手工造三页文档：直接复用 buildPdf 后用 PDFDocument 复制不方便，
  // 改为顺序构造三个独立检查不适用；这里通过多页 PDFDocument 手工建。
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([mm(210), mm(297)]);
    const ctx = doc.context;
    const arr = PDFArray.withContext(ctx);
    const annotsByPage = [
      // 第 1 页：漏印风险（屏显不打印）
      [{ flags: 0, ap: undefined }],
      // 第 2 页：待确认（Print 无外观）
      [{ flags: ANNOT_FLAG.PRINT, ap: undefined, print: true }],
      // 第 3 页：打印候选
      [{ flags: ANNOT_FLAG.PRINT, ap: 'stream' }],
    ][i];
    for (const spec of annotsByPage) {
      const d = PDFDict.withContext(ctx);
      d.set(PDFName.of('Type'), PDFName.of('Annot'));
      d.set(PDFName.of('Subtype'), PDFName.of('Text'));
      const r = PDFArray.withContext(ctx);
      [mm(10), mm(10), mm(50), mm(20)].forEach((v) => r.push(PDFNumber.of(v)));
      d.set(PDFName.of('Rect'), r);
      d.set(PDFName.of('F'), PDFNumber.of(spec.flags));
      if (spec.ap === 'stream') {
        const ap = PDFDict.withContext(ctx);
        const sd = PDFDict.withContext(ctx);
        sd.set(PDFName.of('Subtype'), PDFName.of('Form'));
        sd.set(PDFName.of('BBox'), box(ctx, [0, 0, 10, 10]));
        ap.set(
          PDFName.of('N'),
          ctx.register(PDFRawStream.of(sd, new Uint8Array([0])))
        );
        d.set(PDFName.of('AP'), ap);
      }
      arr.push(d);
    }
    page.node.set(PDFName.of('Annots'), arr);
  }
  const bytes = await doc.save();
  const report = await checkBleedBoxes(Buffer.from(bytes), DEFAULT_OPTS);
  assert.equal(report.pageCount, 3);
  assert.deepEqual(report.summary.annotation.screenRiskPages, [1]);
  assert.deepEqual(report.summary.annotation.printConfirmPages, [2]);
  assert.deepEqual(report.summary.annotation.printOkPages, [3]);
  assert.deepEqual(report.summary.annotation.pagesWithAnnots, [1, 2, 3]);
  assert.equal(report.summary.annotation.counts.total, 3);
  assert.equal(report.summary.annotation.counts.screenRisk, 1);
  assert.equal(report.summary.annotation.counts.printConfirm, 1);
  assert.equal(report.summary.annotation.counts.printOk, 1);
  assert.ok(report.summary.annotation.scopeNote.includes('不模拟'));
});
