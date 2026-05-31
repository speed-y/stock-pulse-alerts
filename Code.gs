// ================================================================
// Stock Pulse — NSE ETF Daily Alert System
// Uses: Yahoo Finance + Gemini Flash (Search-grounded) + Gmail
//       Falls back to Groq (llama-3.3-70b) when Gemini is unavailable.
// ================================================================
// SETUP — Apps Script > Project Settings > Script Properties:
//   GEMINI_API_KEY                → aistudio.google.com
//   GEMINI_MODEL                  → model ID (default: gemini-3.5-flash)
//   GROQ_API_KEY                  → console.groq.com  (fallback when Gemini fails)
//   GROQ_MODEL                    → model ID (default: llama-3.3-70b-versatile)
//   MY_EMAIL                      → your personal Gmail (tracks your replies)
//   BCC_EMAILS                    → comma-separated (optional)
//   SENDER_EMAIL                  → Gmail address that sends the alerts (can be same as MY_EMAIL)
//   TICKERS                       → comma-sep Yahoo symbols (default: GOLDCASE.NS)
//                                    e.g. GOLDCASE.NS,SILVERBEES.NS
//   INITIAL_HOLDINGS_<NAME>       → units held before using this script
//   INITIAL_AVG_PRICE_<NAME>      → avg buy price of those units
//   (replace <NAME> with the ticker name: GOLDCASE, SILVERBEES, etc.)
//   (legacy INITIAL_HOLDINGS / INITIAL_AVG_PRICE still work for GOLDCASE only)
// ================================================================
// TRIGGER: set runAlerts() as a time-driven trigger at 4–5 PM IST on weekdays
// ================================================================
// REPLY FORMAT:
//   "bought"             → confirms recommended units at alert price
//   "bought 500 @ 24.50" → custom units at custom price
//   "sold"               → confirms recommended sell units
//   "sold 300"           → custom sell units
// ================================================================

const TIERS = {
  'Strongly Bullish' : { signal: 'BUY',  invest: 40000 },
  'Bullish'          : { signal: 'BUY',  invest: 20000 },
  'Neutral'          : { signal: 'HOLD', invest: 0     },
  'Bearish'          : { signal: 'SELL', sellPct: 40   },
  'Strongly Bearish' : { signal: 'SELL', sellPct: 75   },
};

// Metadata for known NSE tickers — drives the Gemini prompt context.
// Unknown tickers fall back to generic defaults in tickerMeta().
const TICKER_META = {
  'GOLDCASE.NS'   : { name: 'GOLDCASE',   description: 'NSE:GOLDCASE Indian Gold ETF',          searchHint: 'gold price India INR USD MCX Gold ETF sentiment'      },
  'SILVERBEES.NS' : { name: 'SILVERBEES', description: 'NSE:SILVERBEES Indian Silver ETF',       searchHint: 'silver price India MCX Silver ETF sentiment'          },
  'NIFTYBEES.NS'  : { name: 'NIFTYBEES',  description: 'NSE:NIFTYBEES Nifty 50 Index ETF',      searchHint: 'Nifty 50 FII DII flows Indian equity ETF sentiment'    },
  'JUNIORBEES.NS' : { name: 'JUNIORBEES', description: 'NSE:JUNIORBEES Nifty Next 50 ETF',      searchHint: 'Nifty Next 50 midcap India ETF DII FII sentiment'      },
  'ICICIB22.NS'   : { name: 'ICICIB22',   description: 'NSE:ICICIB22 Bharat Bond ETF 2032',     searchHint: 'India bond yield RBI repo rate debt ETF sentiment'     },
  'LIQUIDBEES.NS' : { name: 'LIQUIDBEES', description: 'NSE:LIQUIDBEES Nippon Liquid ETF',      searchHint: 'India overnight rate liquid ETF RBI policy sentiment'  },
};

function tickerMeta(symbol) {
  if (!symbol) throw new Error('No ticker symbol — run runAlerts(), not sendTickerAlert() directly.');
  if (TICKER_META[symbol]) return TICKER_META[symbol];
  const name = symbol.replace(/\.(NS|BO)$/i, '').toUpperCase();
  return { name, description: `${name} Indian ETF`, searchHint: `${name} India ETF price sentiment` };
}

const E = {
  fire  : String.fromCodePoint(0x1F525),
  green : String.fromCodePoint(0x1F7E2),
  red   : String.fromCodePoint(0x1F534),
  yel   : String.fromCodePoint(0x1F7E1),
  chart : String.fromCodePoint(0x1F4CA),
  warn  : String.fromCodePoint(0x26A0),
};

// ── Entry point ────────────────────────────────────────────────
// Run this function manually or attach it as a time-driven trigger.
// Do NOT run sendTickerAlert() directly — it requires a symbol argument.
function runAlerts() {
  if (!isTradingDay()) { Logger.log('Non-trading day — skipping.'); return; }

  const props   = PropertiesService.getScriptProperties();
  const symbols = (props.getProperty('TICKERS') || 'GOLDCASE.NS')
    .split(',').map(s => s.trim()).filter(Boolean);

  symbols.forEach(symbol => {
    try {
      sendTickerAlert(symbol, props);
    } catch (e) {
      Logger.log(`[${symbol}] Fatal: ${e.message}\n${e.stack}`);
      const MY_EMAIL = props.getProperty('MY_EMAIL');
      const SENDER   = props.getProperty('SENDER_EMAIL');
      if (MY_EMAIL && SENDER) {
        MailApp.sendEmail({
          from: SENDER, to: MY_EMAIL,
          subject: `[Stock Pulse] Error — ${symbol}`,
          body: `${e.message}\n\n${e.stack}`,
        });
      }
    }
  });
}

// Backward-compatible alias
function sendGoldPriceAlert() { runAlerts(); }

// ── Skip weekends and NSE holidays (detected via Yahoo date check) ─
function isTradingDay() {
  const now = new Date();
  if (now.getDay() === 0 || now.getDay() === 6) return false;

  try {
    const resp = UrlFetchApp.fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/GOLDCASE.NS?interval=1d&range=5d',
      { muteHttpExceptions: true }
    );
    const data      = JSON.parse(resp.getContentText());
    const tStamps   = data.chart.result[0].timestamp;
    const lastDate  = Utilities.formatDate(
      new Date(tStamps[tStamps.length - 1] * 1000), 'Asia/Kolkata', 'yyyy-MM-dd'
    );
    const todayDate = Utilities.formatDate(now, 'Asia/Kolkata', 'yyyy-MM-dd');
    return lastDate === todayDate;
  } catch (e) {
    Logger.log('Trading day check failed, proceeding: ' + e.message);
    return true;
  }
}

function sendTickerAlert(symbol, props) {
  const GEMINI_MODEL = props.getProperty('GEMINI_MODEL') || 'gemini-3.5-flash';
  const GEMINI       = props.getProperty('GEMINI_API_KEY');
  const MY_EMAIL     = props.getProperty('MY_EMAIL');
  const BCC_EMAILS   = props.getProperty('BCC_EMAILS') || '';
  const SENDER_EMAIL = props.getProperty('SENDER_EMAIL');
  const meta         = tickerMeta(symbol);

  const sendError = msg => MailApp.sendEmail({
    from: SENDER_EMAIL, to: MY_EMAIL,
    subject: `[Stock Pulse] Error — ${meta.name}`, body: msg,
  });

  // ── 1. Holdings from reply history ───────────────────────────
  const { units: holdings, avgPrice } = getHoldingsFromReplies(symbol, props);

  // ── 2. Yahoo Finance — 30-day price history ───────────────────
  let yahooData;
  try {
    const resp = UrlFetchApp.fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=30d`,
      { muteHttpExceptions: true }
    );
    yahooData = JSON.parse(resp.getContentText());
    if (!yahooData.chart?.result?.[0]) throw new Error('Bad response: ' + resp.getContentText().slice(0, 300));
  } catch (e) { sendError('Yahoo Finance error: ' + e.message); return; }

  const yResult = yahooData.chart.result[0];
  const yMeta   = yResult.meta;
  const closes  = yResult.indicators.quote[0].close;
  const tStamps = yResult.timestamp;

  if (yMeta.regularMarketPrice == null) { sendError(`No price data returned for ${symbol}`); return; }
  const currentPrice = parseFloat(yMeta.regularMarketPrice.toFixed(2));
  const prevClose    = parseFloat((yMeta.chartPreviousClose ?? yMeta.regularMarketPrice).toFixed(2));

  const priceHistory = tStamps.map((t, i) => {
    const d = new Date(t * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    return `${d}: ₹${closes[i] != null ? closes[i].toFixed(2) : 'N/A'}`;
  }).join('\n');

  // ── 3. AI sentiment analysis (Gemini → Groq fallback) ───────────
  const aiPromptBase =
    `You are a financial analyst specializing in Indian markets.\n` +
    `Analyze ${meta.description}.\n\n` +
    `Current price : ₹${currentPrice}\n` +
    `Previous close: ₹${prevClose}\n` +
    `30-day history:\n${priceHistory}\n\n` +
    `Consider price trend, macro factors, and market sentiment.\n` +
    `Reply ONLY in this exact format (no extra text):\n` +
    `SENTIMENT: Strongly Bullish|Bullish|Neutral|Bearish|Strongly Bearish\n` +
    `REASON: <2-3 sentences>`;

  let aiText      = null;
  let geminiError = null;

  // ── 3a. Try Gemini (with Google Search grounding) ─────────────
  if (GEMINI) {
    try {
      const resp = UrlFetchApp.fetch(
        `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI}`,
        {
          method      : 'post',
          contentType : 'application/json',
          payload     : JSON.stringify({
            contents : [{ parts: [{ text:
              aiPromptBase +
              `\n\nUse Google Search to find latest news on: ${meta.searchHint}.`
            }] }],
            tools           : [{ google_search: {} }],
            generationConfig: { temperature: 0 },
          }),
          muteHttpExceptions: true,
        }
      );
      const data = JSON.parse(resp.getContentText());
      Logger.log(`[${symbol}] Gemini: ` + resp.getContentText());
      if (!data.candidates?.[0]) throw new Error(resp.getContentText());
      // Grounding may split the response across multiple parts — join them all
      aiText = data.candidates[0].content.parts.map(p => p.text || '').join('').trim();
    } catch (e) {
      geminiError = e.message;
      Logger.log(`[${symbol}] Gemini failed, trying Groq: ${e.message}`);
    }
  }

  // ── 3b. Groq fallback ─────────────────────────────────────────
  if (!aiText) {
    const GROQ_KEY   = props.getProperty('GROQ_API_KEY');
    const GROQ_MODEL = props.getProperty('GROQ_MODEL') || 'llama-3.3-70b-versatile';
    if (!GROQ_KEY) {
      sendError(
        `Gemini unavailable${geminiError ? ': ' + geminiError : ''} and no GROQ_API_KEY is set.\n` +
        `Add GROQ_API_KEY to Apps Script > Project Settings > Script Properties.`
      );
      return;
    }
    try {
      const resp = UrlFetchApp.fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method      : 'post',
          contentType : 'application/json',
          headers     : { Authorization: 'Bearer ' + GROQ_KEY },
          payload     : JSON.stringify({
            model      : GROQ_MODEL,
            messages   : [{ role: 'user', content: aiPromptBase }],
            temperature: 0,
          }),
          muteHttpExceptions: true,
        }
      );
      const data = JSON.parse(resp.getContentText());
      Logger.log(`[${symbol}] Groq: ` + resp.getContentText());
      if (!data.choices?.[0]) throw new Error(resp.getContentText());
      aiText = data.choices[0].message.content.trim();
    } catch (e) {
      sendError(
        `Both Gemini and Groq failed.\n` +
        `Gemini: ${geminiError || 'no key'}\n` +
        `Groq: ${e.message}`
      );
      return;
    }
  }

  const getVal    = key => { const m = aiText.match(new RegExp(`${key}:\\s*(.+)`)); return m ? m[1].trim() : 'N/A'; };
  const sentiment = getVal('SENTIMENT');
  const reason    = getVal('REASON');

  if (sentiment === 'N/A') Logger.log(`[${symbol}] Warning: could not parse sentiment.\n${aiText}`);

  // ── 4. Signal from tier ───────────────────────────────────────
  const tier      = TIERS[sentiment] || TIERS['Neutral'];
  const signal    = tier.signal;
  const investAmt = tier.invest || 0;
  const buyUnits  = signal === 'BUY'  ? Math.floor(investAmt / currentPrice) : 0;
  const sellUnits = signal === 'SELL' ? Math.floor(holdings * (tier.sellPct / 100)) : 0;

  // ── 5. P&L ───────────────────────────────────────────────────
  let pnlPlain = '', pnlHtml = '';
  if (signal === 'SELL' && holdings > 0 && avgPrice > 0) {
    const pnl    = ((currentPrice - avgPrice) * holdings).toFixed(0);
    const pnlPct = (((currentPrice - avgPrice) / avgPrice) * 100).toFixed(2);
    const sign   = Number(pnl) >= 0 ? '+' : '';
    const pnlStr = `${sign}₹${pnl} (${sign}${pnlPct}%) on ${holdings} units @ avg ₹${avgPrice}`;
    pnlPlain = `P&L       : ${pnlStr}`;
    pnlHtml  = `<tr><td style="padding:3px 12px 3px 0;color:#555">P&amp;L</td><td>${pnlStr}</td></tr>`;
  }

  // ── 6. Compose + send email ───────────────────────────────────
  const change      = (currentPrice - prevClose).toFixed(2);
  const changePct   = ((change / prevClose) * 100).toFixed(2);
  const dir         = Number(change) >= 0 ? '▲' : '▼';
  const date        = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const holdingsStr = `${holdings} units${avgPrice > 0 ? ` @ avg ₹${avgPrice}` : ''}`;
  const sigEmoji    = signal === 'BUY' && sentiment === 'Strongly Bullish' ? E.fire
                    : signal === 'BUY'  ? E.green
                    : signal === 'SELL' ? E.red : E.yel;

  let actionPlain = '', actionHtml = '';
  const aColor = signal === 'BUY' ? '#1a7a1a' : signal === 'SELL' ? '#a00000' : '#333333';
  const aStyle = `padding:3px 0;font-weight:bold;color:${aColor}`;
  if (signal === 'BUY') {
    actionPlain = `Action    : BUY ${buyUnits} units @ ₹${currentPrice} = ₹${(buyUnits * currentPrice).toFixed(0)}`;
    actionHtml  = `<tr><td style="padding:3px 12px 3px 0;color:#555">Action</td><td style="${aStyle}">BUY ${buyUnits} units @ ₹${currentPrice} = ₹${(buyUnits * currentPrice).toFixed(0)}</td></tr>`;
  } else if (signal === 'SELL' && holdings > 0) {
    actionPlain = `Action    : SELL ${sellUnits} of your ${holdings} units (${tier.sellPct}%)`;
    actionHtml  = `<tr><td style="padding:3px 12px 3px 0;color:#555">Action</td><td style="${aStyle}">SELL ${sellUnits} of your ${holdings} units (${tier.sellPct}%)</td></tr>`;
  } else if (signal === 'SELL') {
    actionPlain = `Action    : SELL signal — no holdings tracked yet`;
    actionHtml  = `<tr><td style="padding:3px 12px 3px 0;color:#555">Action</td><td style="${aStyle}">SELL signal — no holdings tracked yet</td></tr>`;
  } else {
    actionPlain = `Action    : HOLD — no action needed`;
    actionHtml  = `<tr><td style="padding:3px 12px 3px 0;color:#555">Action</td><td style="padding:3px 0">HOLD — no action needed</td></tr>`;
  }

  const subject = `${sigEmoji} [${meta.name} ${signal}] ₹${currentPrice} | ${date}`;

  // Plain text body — also used by getHoldingsFromReplies for reply parsing,
  // so keep the "BUY N units @ ₹P" and "SELL N of" patterns stable.
  const plainBody = [
    ...(sentiment === 'Strongly Bullish' ? [`${E.warn} STRONG BUY — High-conviction entry! ${E.warn}`] : []),
    `${E.chart} ${meta.name} (NSE) — ${date}`,
    `Price     : ₹${currentPrice}  ${dir} ₹${Math.abs(change)} (${Math.abs(changePct)}%)`,
    '',
    `Sentiment : ${sentiment}`,
    `Signal    : ${signal}`,
    `Holdings  : ${holdingsStr}`,
    ...(pnlPlain ? [pnlPlain] : []),
    actionPlain,
    '',
    `Analysis  : ${reason}`,
    '',
    '---',
    'Reply to confirm your trade:',
    `  "bought"             — ${buyUnits} units @ ₹${currentPrice}`,
    `  "bought 500 @ 24.50" — custom units & price`,
    `  "sold"               — ${sellUnits} units`,
    `  "sold 300"           — custom sell amount`,
  ].join('\n');

  const htmlBody = `<div style="font-family:monospace;font-size:14px;max-width:580px;line-height:1.6">
    ${sentiment === 'Strongly Bullish'
      ? `<p style="margin:0 0 10px;color:#c05000;font-weight:bold">${E.warn} STRONG BUY — High-conviction entry! ${E.warn}</p>`
      : ''}
    <h3 style="margin:0 0 8px">${E.chart} ${meta.name} (NSE) — ${date}</h3>
    <p style="margin:0 0 12px">Price: <b>₹${currentPrice}</b> &nbsp; ${dir} ₹${Math.abs(change)} (${Math.abs(changePct)}%)</p>
    <table style="border-collapse:collapse">
      <tr><td style="padding:3px 12px 3px 0;color:#555">Sentiment</td><td style="padding:3px 0">${sentiment}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#555">Signal</td>   <td style="padding:3px 0">${signal}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#555">Holdings</td> <td style="padding:3px 0">${holdingsStr}</td></tr>
      ${pnlHtml}
      ${actionHtml}
    </table>
    <p style="margin:14px 0 10px">${reason}</p>
    <hr style="border:none;border-top:1px solid #e0e0e0;margin:10px 0">
    <p style="color:#777;font-size:12px;margin:0">
      Reply to confirm your trade:<br>
      &nbsp; <code>bought</code> &mdash; ${buyUnits} units @ ₹${currentPrice}<br>
      &nbsp; <code>bought 500 @ 24.50</code> &mdash; custom units &amp; price<br>
      &nbsp; <code>sold</code> &mdash; ${sellUnits} units<br>
      &nbsp; <code>sold 300</code> &mdash; custom sell amount
    </p>
  </div>`;

  const emailOpts = {
    from    : SENDER_EMAIL,
    to      : MY_EMAIL,
    subject : subject,
    body    : plainBody,   // plain text for reply parsing
    htmlBody: htmlBody,
  };
  if (BCC_EMAILS) emailOpts.bcc = BCC_EMAILS;

  MailApp.sendEmail(emailOpts);
  Logger.log(`[${symbol}] Alert sent: ${subject}`);
}

// ── Parse reply history (sorted by date) to compute holdings ────
function getHoldingsFromReplies(symbol, props) {
  const MY_EMAIL     = props.getProperty('MY_EMAIL');
  const SENDER_EMAIL = props.getProperty('SENDER_EMAIL');
  const meta         = tickerMeta(symbol);
  const nameKey      = meta.name.toUpperCase();

  // Per-ticker initial holdings; legacy single-key fallback for GOLDCASE
  const initUnits = parseInt(
    props.getProperty(`INITIAL_HOLDINGS_${nameKey}`) ||
    (symbol === 'GOLDCASE.NS' ? props.getProperty('INITIAL_HOLDINGS') : null) || '0'
  );
  const initAvg = parseFloat(
    props.getProperty(`INITIAL_AVG_PRICE_${nameKey}`) ||
    (symbol === 'GOLDCASE.NS' ? props.getProperty('INITIAL_AVG_PRICE') : null) || '0'
  );

  let totalUnits = Math.max(0, initUnits);
  let totalCost  = Math.max(0, initAvg * initUnits);

  // Search the user's sent mail for replies to this ticker's alert threads
  const threads = GmailApp.search(
    `subject:${meta.name} in:sent to:${SENDER_EMAIL}`, 0, 200
  );

  const events = [];

  threads.forEach(thread => {
    const messages = thread.getMessages();
    const alertMsg = messages.find(m =>
      m.getFrom().toLowerCase().includes(SENDER_EMAIL.toLowerCase())
    );

    messages.forEach(msg => {
      if (!msg.getFrom().toLowerCase().includes(MY_EMAIL.toLowerCase())) return;

      const firstLine = msg.getPlainBody()
        .split('\n')
        .map(l => l.trim())
        .find(l => l.length > 0 && !l.startsWith('>') && !l.startsWith('On ')) || '';

      const lower       = firstLine.toLowerCase();
      const boughtMatch = lower.match(/^bought(?:\s+(\d+)(?:\s*@\s*([\d.]+))?)?/);
      const soldMatch   = lower.match(/^sold(?:\s+(\d+))?/);

      if (boughtMatch || soldMatch) {
        events.push({ date: msg.getDate(), boughtMatch, soldMatch, alertMsg });
      }
    });
  });

  events.sort((a, b) => a.date - b.date);

  events.forEach(({ boughtMatch, soldMatch, alertMsg }) => {
    if (boughtMatch) {
      let units = 0, buyPrice = 0;

      if (boughtMatch[1]) {
        units    = parseInt(boughtMatch[1]);
        buyPrice = boughtMatch[2] ? parseFloat(boughtMatch[2]) : 0;
      } else if (alertMsg) {
        // Match "BUY 123 units @ ₹24.50" — handles both ₹ and legacy Rs. notation
        const m = alertMsg.getPlainBody().match(/BUY (\d+) units @ (?:₹|Rs\.?)\s*([\d.]+)/i);
        if (m) { units = parseInt(m[1]); buyPrice = parseFloat(m[2]); }
      }

      if (units > 0) {
        totalCost  += buyPrice > 0 ? units * buyPrice : 0;
        totalUnits += units;
      }
    }

    if (soldMatch) {
      let units = soldMatch[1] ? parseInt(soldMatch[1]) : 0;
      if (!units && alertMsg) {
        const m = alertMsg.getPlainBody().match(/SELL (\d+) (?:of|units)/i);
        if (m) units = parseInt(m[1]);
      }
      if (units > 0 && totalUnits > 0) {
        totalCost  = totalCost * ((totalUnits - units) / totalUnits);
        totalUnits = Math.max(0, totalUnits - units);
      }
    }
  });

  const avgPrice = totalUnits > 0 ? parseFloat((totalCost / totalUnits).toFixed(2)) : 0;
  return { units: Math.max(0, totalUnits), avgPrice };
}
