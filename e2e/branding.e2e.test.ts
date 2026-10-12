// The seed applies Mattermost's built-in Enterprise Brain branding (D44, spike findings item 32).
import { loadDotEnv } from '@brain/shared';
import { describe, expect, it } from 'vitest';

loadDotEnv();

describe('branding', () => {
  it('Mattermost shows the Enterprise Brain name and logo before sign-in', async () => {
    const url = process.env.MM_URL ?? '';
    const config = (await (await fetch(`${url}/api/v4/config/client?format=old`)).json()) as Record<string, string>;
    expect(config).toMatchObject({ SiteName: 'Enterprise Brain', EnableCustomBrand: 'true', EnableDesktopLandingPage: 'false' });
    const image = await fetch(`${url}/api/v4/brand/image`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
  });
});
