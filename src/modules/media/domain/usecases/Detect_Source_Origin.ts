import { SourceOrigin } from './types.js';
import {
  isMegaUrl,
  isYoutubeUrl,
  parseSafeMediaUrl,
} from '../../../../shared/urlSafety.js';

export function detectSourceOrigin(url: string): SourceOrigin {
  const hostname = parseSafeMediaUrl(url).hostname.toLowerCase();

  const isDomain = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);

  if (isYoutubeUrl(url)) return 'youtube';
  if (isDomain('instagram.com')) return 'instagram';
  if (isDomain('vimeo.com')) return 'vimeo';
  if (isDomain('reddit.com')) return 'reddit';
  if (hostname === 't.me' || hostname.endsWith('.t.me')) return 'telegram';
  if (isDomain('twitter.com') || isDomain('x.com')) return 'x';
  if (isDomain('facebook.com') || hostname === 'fb.watch' || hostname.endsWith('.fb.watch')) return 'facebook';
  if (hostname === 'pinterest.com' || hostname.startsWith('pinterest.')) return 'pinterest';
  if (isDomain('aminoapps.com')) return 'amino';
  if (hostname.includes('.blogspot.') || isDomain('blogger.com')) return 'blogger';
  if (isDomain('twitch.tv')) return 'twitch';
  if (isDomain('kick.com')) return 'kick';
  if (isDomain('snapchat.com')) return 'snapchat';
  if (isDomain('qq.com')) return 'qq';
  if (isDomain('threads.net')) return 'threads';
  if (isDomain('vk.com')) return 'vk';
  if (isDomain('4chan.org')) return '4chan';
  if (isMegaUrl(url)) return 'mega';

  return 'generic';
}
