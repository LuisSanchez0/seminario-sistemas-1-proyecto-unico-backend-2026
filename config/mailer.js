const nodemailer = require('nodemailer');

// Local QA can use an SMTP capture server; production keeps the existing Gmail transport.
const transporter = nodemailer.createTransport(process.env.NODE_ENV === 'test' && process.env.QA_SMTP_PORT ? {
  host: '127.0.0.1', port: Number(process.env.QA_SMTP_PORT), secure: false, ignoreTLS: true
} : {
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

module.exports = {
  transporter
};