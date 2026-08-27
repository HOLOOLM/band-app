// Fase 5 — udgående mail via Resend.
//
// Erstatter MailApp/GmailApp i Apps Script. Grunden er ikke at Gmail ikke
// virker, men at kvoten er lille og delt med kontoens egen mail, og at afsenderen
// bliver en gmail-adresse frem for bandets eget domæne.
//
// Resend gratis: 3.000 mails/måned, 100/dag. Afsenderdomænet skal verificeres med
// SPF/DKIM/DMARC, ellers ryger mailen i spam — det er brugerens opgave i Fase 0.
//
// ALLE kald hertil skal være fire-and-forget hos kalderen. En mislykket mail må
// aldrig fortryde en gennemført handling: en underskrift der ruller tilbage fordi
// kvitteringsmailen fejlede, er værre end en manglende kvittering.

import { userError } from '../lib/errors.js';

const TIMEOUT_MS = 15000;
const RESEND_URL = 'https://api.resend.com/emails';

export function mailConfigured(env) {
  return !!(env.RESEND_API_KEY && env.MAIL_FROM);
}

/**
 * Sender en mail. Kaster ved fejl, så kalderen kan logge — men kalderen skal
 * fange og fortsætte.
 *
 * `to` kan være en kommasepareret streng eller et array; Resend vil have et
 * array.
 */
export async function sendMail(env, { to, subject, html, text, replyTo, attachments }) {
  if (!mailConfigured(env)) {
    throw userError('Mailtjenesten er ikke konfigureret endnu');
  }
  const modtagere = Array.isArray(to)
    ? to.filter(Boolean)
    : String(to || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!modtagere.length) throw userError('Ingen modtager angivet');

  const body = {
    from: env.MAIL_FROM,
    to: modtagere,
    subject: String(subject || '(uden emne)')
  };
  if (html) body.html = html;
  if (text) body.text = text;
  if (replyTo) body.reply_to = replyTo;
  // Vedhæftninger sendes som base64. Bruges til at sende den underskrevne
  // kontrakt-PDF med kvitteringsmailen.
  if (attachments && attachments.length) {
    body.attachments = attachments.map(a => ({
      filename: a.filename,
      content: a.contentBase64
    }));
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const svar = await res.text();
    if (!res.ok) {
      // Resends fejlbesked er brugbar til fejlsøgning, men må ikke nå brugeren —
      // den kan indeholde konto- og domænedetaljer.
      console.error('Resend afviste mail (' + res.status + '): ' + svar.slice(0, 300));
      throw userError('Mailen kunne ikke sendes');
    }
    let data = {};
    try { data = JSON.parse(svar); } catch (e) {}
    return { ok: true, id: data.id || '' };
  } catch (e) {
    if (e && e.userFacing) throw e;
    if (e && e.name === 'AbortError') throw userError('Mailtjenesten svarede ikke i tide');
    console.error('Mailkald fejlede: ' + (e && e.message || e));
    throw userError('Mailen kunne ikke sendes');
  } finally {
    clearTimeout(timer);
  }
}
