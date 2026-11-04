'use strict';
const name = new URL(location.href).searchParams.get('media');
const video = document.getElementById('local-video'), offline = new URL(location.href).searchParams.get('offline');
const playback = new URL(location.href).searchParams.get('playback');
if (/^[a-f0-9]{64}\.(mp4|m4a)$/.test(offline || '') && /^[a-f0-9-]{36}$/.test(playback || '')) video.src = `favecus://offline/${offline}?playback=${playback}`;
if (/^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/.test(name || '')) video.src = `favecus://media/${name}`;
video.addEventListener('error', () => { document.getElementById('local-error').textContent = '再生できません。ファイルの有無と形式を確認してください。MP4はH.264/AAC、WebMはVP8/VP9/Opusが目安です。'; });
