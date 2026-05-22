import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';

@Injectable()
export class PushNotificationService {
  private readonly serverKey: string | undefined;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {
    this.serverKey = this.configService.get<string>('FCM_SERVER_KEY');
  }

  /**
   * Sends a push notification to a single user identified by userId.
   * Uses the FCM Legacy HTTP API with the server key from .env.
   * Never throws — notification failure must not affect the main flow.
   */
  async sendToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (!this.serverKey) return;

    try {
      const user = await this.userRepo.findOne({ where: { id: userId } });
      if (!user?.fcmToken) return;
      await this.sendRaw(user.fcmToken, title, body, data);
    } catch (err) {
      console.error('[FCM] sendToUser failed:', (err as Error).message);
    }
  }

  /**
   * Sends a push notification directly to a known FCM token.
   */
  async sendToToken(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (!this.serverKey || !token) return;
    try {
      await this.sendRaw(token, title, body, data);
    } catch (err) {
      console.error('[FCM] sendToToken failed:', (err as Error).message);
    }
  }

  private async sendRaw(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        Authorization: `key=${this.serverKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: token,
        notification: { title, body },
        data: data ?? {},
        priority: 'high',
        android: { priority: 'high' },
        apns: { headers: { 'apns-priority': '10' } },
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[FCM] HTTP error:', res.status, text);
    }
  }
}
