/** 加密 5 分钟页 */
initPolymarketCryptoShort({
  intervalKey: '5M',
  slotSec: 300,
  slugMin: '5m',
  intervalNum: 5,
  globalApiName: 'Crypto5M',
  category: 'crypto5m',
  showSpotPrices: false,
  hideSourceColumn: true,
  hideVolumeOiColumns: true,
  hideOrderButtons: true,
  /** 表格增加马尔可夫策略列（持续概率 / j* / 进场） */
  showMarkovColumn: true,
  /** 订单簿刷新只更新 Up/Down 单元格，不重绘整表 */
  asyncBookRefresh: true,
  asyncStatsRefresh: true,
  /** 倒计时显示在「5M Markets」标题旁，表格行内不再重复 */
  panelSlotCountdown: true,
  fixedOrderUsdc: 1,
  skipMinSizeBump: true,
  /** 仅当 Up/Down 价格 >90¢ 且 <95¢ 时下单（边界不含） */
  autoBuy90: { threshold: 0.9, maxThreshold: 0.95, amountUsd: 1, oncePerSlot: true, excludeBtc: true },
  /** 每槽结束时追加写入 crypto-5m-slot-results.txt */
  slotResultLog: true,
  /**
   * 虚拟共识策略：
   * - Up/Down 各≥triggerMin 个到 triggerCents → 7 市场该边 (entryMin,entryMax) 各 amountUsd
   * - 槽剩余 < minSlotRemSec 不开新仓；同边 < holdMinCents 的 market 数 < triggerMin 视为共识弱化
   * - 共识已触发时，任一同边 < divergenceBelowCents → 本槽整局跳过
   */
  virtualBet: {
    amountUsd: 5,
    startBankroll: 100,
    triggerMin: 2,
    triggerCents: 90,
    entryMinCents: 70,
    entryMaxCents: 98,
    minSlotRemSec: 40,
    holdMinCents: 85,
    divergenceBelowCents: 20,
  },
  urgentMs: 60000,
  badgeClass: '',
  badgeLabel: '5m',
  sourceLabel: '5M · 盘口',
  pageTitle: '5M',
  resultUrl: 'polymarket.com/crypto/5M',
});
