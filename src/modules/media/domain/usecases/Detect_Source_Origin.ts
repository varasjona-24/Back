import { SourceOrigin } from './types.js';

export function detectSourceOrigin(url: string): SourceOrigin {
  const u = url.toLowerCase();

  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('vimeo.com')) return 'vimeo';
  if (u.includes('reddit.com')) return 'reddit';
  if (u.includes('t.me')) return 'telegram';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'x';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'facebook';
  if (u.includes('pinterest.')) return 'pinterest';
  if (u.includes('aminoapps.com')) return 'amino';
  if (u.includes('blogspot.') || u.includes('blogger.com')) return 'blogger';
  if (u.includes('twitch.tv')) return 'twitch';
  if (u.includes('kick.com')) return 'kick';
  if (u.includes('snapchat.com')) return 'snapchat';
  if (u.includes('qq.com')) return 'qq';
  if (u.includes('threads.net')) return 'threads';
  if (u.includes('vk.com')) return 'vk';
  if (u.includes('4chan.org')) return '4chan';
  if (u.includes('mega.nz') || u.includes('mega.co.nz')) return 'mega';

  return 'generic';
}
