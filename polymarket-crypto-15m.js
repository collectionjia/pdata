/** 加密 15 分钟页 */
initPolymarketCryptoShort({
  intervalKey: '15M',
  slotSec: 900,
  slugMin: '15m',
  intervalNum: 15,
  globalApiName: 'Crypto15M',
  category: 'crypto15m',
  /** 与 5M 相同：订单簿异步刷新单元格；倒计时结束整表换槽 */
  asyncBookRefresh: true,
  asyncStatsRefresh: true,
  /** 倒计时在「15M Markets」标题旁 */
  panelSlotCountdown: true,
  fixedOrderUsdc: 1,
  skipMinSizeBump: true,
  /**
   * 虚拟共识策略（与 5M 相同参数；余额/订单与 5M 独立存储）
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
  urgentMs: 120000,
  badgeClass: ' m15',
  badgeLabel: '15m',
  sourceLabel: '15M · 盘口',
  pageTitle: '15M',
  resultUrl: 'polymarket.com/crypto/15M',
});
