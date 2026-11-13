'use strict';

// Email templates — neutral, professional Nexora branding (indigo/slate).
// Koi romantic copy nahi. Tokens kabhi log nahi hote.

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function baseLayout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f1f5f9;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="background-color:#4f46e5;padding:24px 32px;">
              <div style="color:#ffffff;font-size:20px;font-weight:600;letter-spacing:0.02em;">Nexora</div>
              <div style="color:#c7d2fe;font-size:13px;margin-top:4px;">Secure Messenger</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 16px 0;font-size:18px;font-weight:600;color:#0f172a;">${escapeHtml(title)}</h1>
              ${bodyHtml}
              <p style="margin:24px 0 0 0;font-size:13px;color:#64748b;line-height:1.6;">
                If you did not request this, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
              <div style="font-size:12px;color:#94a3b8;">This is an automated message from Nexora. Please do not reply.</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function tokenBlock(token) {
  return `<div style="margin:20px 0;padding:16px 20px;background-color:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;">
    <div style="font-family:'Courier New',monospace;font-size:24px;font-weight:700;letter-spacing:0.15em;color:#312e81;word-break:break-all;">${escapeHtml(token)}</div>
  </div>`;
}

function linkLine(link) {
  if (!link) {
    return '';
  }
  return `<p style="margin:20px 0 0 0;font-size:14px;color:#334155;line-height:1.6;">
    Alternatively, use this link:<br />
    <a href="${escapeHtml(link)}" style="color:#4f46e5;word-break:break-all;">${escapeHtml(link)}</a>
  </p>`;
}

function verificationEmail({ token, expiresInText, link }) {
  const title = 'Verify your Nexora email';
  const body = `
    <p style="margin:0 0 8px 0;font-size:14px;color:#334155;line-height:1.6;">Welcome to Nexora. Use the code below to verify your email address:</p>
    ${tokenBlock(token)}
    <p style="margin:0;font-size:13px;color:#64748b;">This code expires in ${escapeHtml(expiresInText)} and can only be used once.</p>
    ${linkLine(link)}`;
  return baseLayout(title, body);
}

function passwordResetEmail({ token, expiresInText, link }) {
  const title = 'Reset your Nexora password';
  const body = `
    <p style="margin:0 0 8px 0;font-size:14px;color:#334155;line-height:1.6;">A password reset was requested for your Nexora account. Use the code below to set a new password:</p>
    ${tokenBlock(token)}
    <p style="margin:0;font-size:13px;color:#64748b;">This code expires in ${escapeHtml(expiresInText)} and can only be used once.</p>
    <p style="margin:16px 0 0 0;font-size:13px;color:#64748b;">If you did not request a password reset, no action is needed — your password stays unchanged.</p>
    ${linkLine(link)}`;
  return baseLayout(title, body);
}

function verificationText({ token, expiresInText, link }) {
  let text = `Nexora — Verify your email\n\nYour verification code: ${token}\nThis code expires in ${expiresInText} and can only be used once.`;
  if (link) {
    text += `\n\nOr use this link: ${link}`;
  }
  return text;
}

function passwordResetText({ token, expiresInText, link }) {
  let text = `Nexora — Reset your password\n\nYour password reset code: ${token}\nThis code expires in ${expiresInText} and can only be used once.`;
  if (link) {
    text += `\n\nOr use this link: ${link}`;
  }
  return text;
}

module.exports = { verificationEmail, passwordResetEmail, verificationText, passwordResetText };
