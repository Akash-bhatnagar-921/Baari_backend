import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SmsService {
  private readonly apiKey: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('FAST2SMS_API_KEY');
  }

  /**
   * Sends a free-text transactional SMS via Fast2SMS quick route.
   * Use for reminders, alerts, and status updates (not OTPs).
   * Never throws — SMS is best-effort.
   */
  async sendMessage(phone: string, message: string): Promise<boolean> {
    if (!this.apiKey) {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[DEV SMS] phone=${phone} msg=${message}`);
      }
      return false;
    }
    try {
      const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: { authorization: this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: 'q', message, numbers: phone, flash: 0 }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { return?: boolean };
      return data.return === true;
    } catch (err) {
      console.error('[SMS] Delivery failed:', (err as Error).message);
      return false;
    }
  }

  /**
   * Sends a 6-digit OTP via Fast2SMS (Indian SMS gateway).
   * Returns true when the API confirms delivery, false on any failure.
   * Never throws — SMS is best-effort; email is the authoritative channel.
   */
  async sendOtp(phone: string, otp: string): Promise<boolean> {
    if (!this.apiKey) {
      // No API key configured — log in dev so devs can still test without SMS.
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[DEV SMS OTP] phone=${phone} otp=${otp}`);
      }
      return false;
    }

    try {
      const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: {
          authorization: this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          route: 'otp',
          variables_values: otp,
          numbers: phone,
        }),
        signal: AbortSignal.timeout(8_000), // 8-second hard limit
      });

      if (!res.ok) return false;
      const data = (await res.json()) as { return?: boolean };
      return data.return === true;
    } catch (err) {
      console.error('[SMS OTP] Delivery failed:', (err as Error).message);
      return false;
    }
  }
}
