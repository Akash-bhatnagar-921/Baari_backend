import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, Worker } from 'bullmq';
import { createTransport, Transporter } from 'nodemailer';

type LoginOtpEmailJob = {
  to: string;
  otp: string;
};

type ApprovalEmailData = {
  ownerName: string;
  salonName: string;
  address: string;
  city: string;
  state: string;
  phone: string;
  secretCode: string;
};

@Injectable()
export class EmailQueueService implements OnModuleDestroy {
  private queue?: Queue<LoginOtpEmailJob>;
  private worker?: Worker<LoginOtpEmailJob>;
  private readonly transporter: Transporter;
  private readonly hasSmtpConfig: boolean;
  private readonly isQueueEnabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.hasSmtpConfig = Boolean(this.configService.get<string>('SMTP_HOST'));
    this.isQueueEnabled =
      this.configService.get<string>('EMAIL_QUEUE_ENABLED') === 'true';

    this.transporter = this.createTransporter();

    if (this.isQueueEnabled) {
      this.initializeQueue();
    }
  }

  async enqueueLoginOtpEmail(to: string, otp: string) {
    if (!this.queue) {
      await this.sendLoginOtpEmail(to, otp);
      return;
    }

    await this.queue.add(
      'send-login-otp',
      { to, otp },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 3000,
        },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  async sendApprovalEmail(to: string, data: ApprovalEmailData) {
    const from =
      this.configService.get<string>('SMTP_FROM') ?? 'Baari <no-reply@baari.local>';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body{font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px}
    .wrap{background:#fff;border-radius:12px;padding:32px;max-width:600px;margin:0 auto}
    .hdr{text-align:center;color:#2D9248;margin-bottom:24px}
    .hdr h1{margin:0;font-size:26px}
    .hdr p{margin:6px 0 0;color:#555}
    .row{padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px}
    .row strong{display:inline-block;width:130px;color:#333}
    .code-box{background:#6FCF97;color:#fff;border-radius:10px;padding:16px 24px;
              font-size:30px;font-weight:bold;letter-spacing:6px;text-align:center;margin:24px 0}
    .note{background:#fffbe6;border:1px solid #ffe58f;border-radius:8px;
          padding:12px 16px;font-size:13px;color:#7d6608;margin-top:4px}
    .footer{text-align:center;color:#aaa;font-size:12px;margin-top:28px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <h1>Welcome to Baari! ✂️</h1>
      <p>Congratulations on your successful onboarding!</p>
    </div>
    <p style="color:#555">Your salon has been <strong style="color:#2D9248">verified and approved</strong>. Here are your registered details:</p>
    <div class="row"><strong>Owner Name</strong>${data.ownerName}</div>
    <div class="row"><strong>Salon Name</strong>${data.salonName}</div>
    <div class="row"><strong>Address</strong>${data.address}, ${data.city}, ${data.state}</div>
    <div class="row"><strong>Phone</strong>${data.phone}</div>
    <p style="margin-top:24px;font-weight:bold;color:#333">Your Salon Secret Code (Non-Expiry):</p>
    <div class="code-box">${data.secretCode}</div>
    <div class="note">
      Keep this code <strong>safe and private</strong>. You will need to enter it every time you log in to the Baari Professional dashboard as a second verification step.
    </div>
    <div class="footer">
      <p>This code does not expire. Never share it with anyone.</p>
      <p style="margin-top:8px">© Baari — Book Your Salon</p>
    </div>
  </div>
</body>
</html>`;

    await this.transporter.sendMail({
      from,
      to,
      subject: 'Your Baari salon has been approved!',
      text: `Congratulations ${data.ownerName}! Your salon "${data.salonName}" has been approved. Your secret login code is: ${data.secretCode}. Keep it safe — you need it to log in.`,
      html,
    });

    if (!this.hasSmtpConfig) {
      console.log(`DEV APPROVAL EMAIL for ${to}: secret code = ${data.secretCode}`);
    }
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
  }

  private initializeQueue() {
    const connection = {
      host: this.configService.get<string>('REDIS_HOST') ?? '127.0.0.1',
      port: Number(this.configService.get<string>('REDIS_PORT') ?? 6379),
    };

    this.queue = new Queue<LoginOtpEmailJob>('login-otp-email', {
      connection,
    });

    this.worker = new Worker<LoginOtpEmailJob>(
      'login-otp-email',
      async (job: Job<LoginOtpEmailJob>) => {
        await this.sendLoginOtpEmail(job.data.to, job.data.otp);
      },
      { connection },
    );

    this.queue.on('error', (error) => {
      console.error('Login OTP email queue error:', error.message);
    });

    this.worker.on('error', (error) => {
      console.error('Login OTP email worker error:', error.message);
    });
  }

  private createTransporter() {
    if (!this.hasSmtpConfig) {
      return createTransport({ jsonTransport: true });
    }

    return createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port: Number(this.configService.get<string>('SMTP_PORT') ?? 587),
      secure: this.configService.get<string>('SMTP_SECURE') === 'true',
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  private async sendLoginOtpEmail(to: string, otp: string) {
    const from =
      this.configService.get<string>('SMTP_FROM') ?? 'Baari <no-reply@baari.local>';

    await this.transporter.sendMail({
      from,
      to,
      subject: 'Your Baari login OTP',
      text: `Your Baari login OTP is ${otp}. It expires in 5 minutes.`,
      html: `<p>Your Baari login OTP is <strong>${otp}</strong>.</p><p>It expires in 5 minutes.</p>`,
    });

    if (!this.hasSmtpConfig) {
      console.log(`DEV LOGIN OTP for ${to}: ${otp}`);
    }
  }
}
