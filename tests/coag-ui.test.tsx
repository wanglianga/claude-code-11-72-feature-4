import type { ReactElement } from 'react';
/**
 * 界面渲染冒烟：用真实样例数据构造 CoagState，服务端渲染各页面，
 * 断言关键文案与数值存在（不依赖浏览器/IndexedDB）。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolve } from 'node:path';
import { parseCoagSampleFromDisk } from '../scripts/coagParse';
import { computeTankEfficiency } from '../src/coag/engine';
import { CoagPairingPage } from '../src/ui/coag/CoagPairingPage';
import { CoagShiftPage } from '../src/ui/coag/CoagShiftPage';
import { CoagConditionPage } from '../src/ui/coag/CoagConditionPage';
import { CoagAnomalyPage } from '../src/ui/coag/CoagAnomalyPage';
import { CoagRecapPage } from '../src/ui/coag/CoagRecapPage';
import { CoagLedgerPage } from '../src/ui/coag/CoagLedgerPage';
import { CoagVerifyPage } from '../src/ui/coag/CoagVerifyPage';
import type { CoagActions, CoagState } from '../src/ui/coag/useCoagState';

const sample = parseCoagSampleFromDisk(resolve(__dirname, '../public/sample/coag'));
const manifest = sample.manifest;
const eff = computeTankEfficiency(sample.dataset, 'CT-01', manifest.day, {
  reviewCutoffReceivedAt: manifest.focus.reviewCutoffReceivedAt,
});

const noop = async (): Promise<void> => {};
const actions: CoagActions = {
  loadSample: noop,
  importLate: noop,
  setTank: () => {},
  recompute: noop,
  reviewCandidate: noop,
  toast: () => {},
  dismissToast: () => {},
  reload: noop,
  reset: noop,
};

const state: CoagState = {
  ready: true,
  loading: false,
  progress: null,
  dataset: sample.dataset,
  manifest,
  tankId: 'CT-01',
  efficiency: eff,
  computing: false,
  computeError: null,
  toasts: [],
  reviews: {},
  audits: [],
  fingerprints: sample.fingerprints,
  issues: sample.issues,
  lastComputeMs: eff.computeMs,
};

function render(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

describe('混凝界面渲染', () => {
  it('配对页展示窗口、投加与去除', () => {
    const html = render(<CoagPairingPage state={state} actions={actions} />);
    expect(html).toContain('可达出水窗口配对');
    expect(html).toContain('泵脉冲');
    expect(html).toContain('可排名');
    // 至少存在一个时间窗口标签
    expect(html).toMatch(/\d{2}:\d{2}–\d{2}:\d{2}（停留 \d+–\d+ s）/);
  });

  it('班次页并列入库量与实际投加', () => {
    const html = render(<CoagShiftPage state={state} actions={actions} />);
    expect(html).toContain('班次复盘');
    expect(html).toContain('不是投加');
    expect(html).toContain('班内混合工况');
  });

  it('工况页披露短片段与未覆盖', () => {
    const html = render(<CoagConditionPage state={state} actions={actions} />);
    expect(html).toContain('工况分段与效率对照');
    expect(html).toContain('未覆盖');
    expect(html).toContain('短片段');
  });

  it('异常页四类归因可渲染', () => {
    const html = render(<CoagAnomalyPage state={state} actions={actions} />);
    for (const label of ['缺料', '计量不确定', '工况突变', '待取样']) expect(html).toContain(label);
  });

  it('复盘页展示迟到候选与处置只读说明', () => {
    const html = render(<CoagRecapPage state={state} actions={actions} />);
    expect(html).toContain('迟到化验');
    expect(html).toContain('不改写');
  });

  it('账页包含批次、转罐、脉冲、处置与审计', () => {
    const html = render(<CoagLedgerPage state={state} actions={actions} />);
    expect(html).toContain('药剂批次账');
    expect(html).toContain('库存平衡');
    expect(html).toContain('B-2026-1119');
  });

  it('样例页列出指纹与场景', () => {
    const html = render(<CoagVerifyPage state={state} />);
    expect(html).toContain('样例清单与指纹');
    expect(html).toContain('匹配');
    expect(html).toContain('暴雨');
  });

  it('空数据时给出装载入口而不崩溃', () => {
    const emptyState: CoagState = {
      ...state,
      dataset: { ...sample.dataset, tanks: [], readings: [] },
      efficiency: null,
    };
    const html = render(<CoagPairingPage state={emptyState} actions={actions} />);
    expect(html).toContain('装载混凝样例');
  });
});

describe('应用外壳渲染', () => {
  it('顶栏与侧栏包含两个模块入口，默认页面不崩溃', async () => {
    const { App } = await import('../src/ui/App');
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('排口负荷复核');
    expect(html).toContain('混凝投加复核');
    expect(html).toContain('对应窗口配对');
    expect(html).toContain('正在打开本地库');
  });
});
