'use strict';

const nodemailer = require('nodemailer');
const config = require('../../config');
const logger = require('../logger');
const templates = require('./templates');

// Mail delivery abstraction — future mein Brevo/SMTP2GO/SendGrid/Mailgun par
// auth logic change kiye baghair migrate ho sakte hain.
//
// Dev-only LogTransport: jab SMTP configure nahi hai to email bheji nahi jaati,
// sirf metadata log hota hai (tokens kabhi nahi).

class LogTransport {
  async sendMail({ to, subject }) {
    logger.warn({ to, subject }, '[mail] SMTP configured nahi hai — email log-only (dev mode)');
    return { messageId: 'dev-log-only' };
  }
}

class MailService {
  constructor(transport) {
    this.transport = transport;
  }

  static create() {
    if (config.smtpConfigured) {
      const transport = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure, // Gmail STARTTLS ke liye false
        auth: {
          user: config.smtp.user,
          pass: config.smtp.pass,
        },
      });
      return new MailService(transport);
    }
    logger.warn('[mail] SMTP_* env vars missing hain — LogTransport use ho raha hai (emails nahi jayengi)');
    return new MailService(new LogTransport());
  }

  _sender() {
    return config.smtp.from || `${config.appName} <no-reply@nexora.app>`;
  }

  async _send({ to, subject, html, text }) {
    return this.transport.sendMail({
      from: this._sender(),
      to,
      subject,
      html,
      text,
    });
  }

  async sendVerificationEmail({ to, token, expiresInText }) {
    const link = config.emailLinkBaseUrl
      ? `${config.emailLinkBaseUrl}/verify-email?token=${encodeURIComponent(token)}`
      : '';
    await this._send({
      to,
      subject: 'Your Nexora verification code',
      html: templates.verificationEmail({ token, expiresInText, link }),
      text: templates.verificationText({ token, expiresInText, link }),
    });
  }

  async sendPasswordResetEmail({ to, token, expiresInText }) {
    const link = config.emailLinkBaseUrl
      ? `${config.emailLinkBaseUrl}/reset-password?token=${encodeURIComponent(token)}`
      : '';
    await this._send({
      to,
      subject: 'Your Nexora password reset code',
      html: templates.passwordResetEmail({ token, expiresInText, link }),
      text: templates.passwordResetText({ token, expiresInText, link }),
    });
  }
}

module.exports = { MailService };
