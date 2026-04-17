import { createTransport } from 'nodemailer';

/**
 * Drop a test email into GreenMail's SMTP so it lands in the receiver's
 * INBOX. GreenMail with `greenmail.setup.test.all` auto-creates user
 * mailboxes on first receipt, so this is all the setup we need.
 */
export async function seedEmail(options: {
  host: string;
  smtpPort: number;
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  cc?: string[];
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}): Promise<void> {
  const transporter = createTransport({
    host: options.host,
    port: options.smtpPort,
    secure: false,
    auth: { user: 'test', pass: 'test' },
    tls: { rejectUnauthorized: false },
  });

  try {
    await transporter.sendMail({
      from: options.from,
      to: options.to,
      ...(options.cc !== undefined && { cc: options.cc }),
      subject: options.subject,
      ...(options.text !== undefined && { text: options.text }),
      ...(options.html !== undefined && { html: options.html }),
      ...(options.attachments !== undefined && { attachments: options.attachments }),
    });
  } finally {
    transporter.close();
  }
}
