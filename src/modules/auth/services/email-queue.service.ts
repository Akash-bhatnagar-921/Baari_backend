import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, Worker } from 'bullmq';
import { createTransport, Transporter } from 'nodemailer';

type LoginOtpEmailJob = {
  to: string;
  otp: string;
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
