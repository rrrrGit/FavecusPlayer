'use strict';
// IPC：アカウント・Bilibili・ヘルプ
// main.cjs から分けたもの（動作は同じ）。状態（store・current など）は、ctx 経由で、その都度読む（S.store など）。
module.exports = function RegisterAccount(ctx) {
  const S = ctx;
  const { Accounts, DriveURL, Handle, OpenAccount, OpenHelp, Resources, path, shell } = ctx;
  Handle('account:status', Accounts);
  Handle('account:open', OpenAccount);
  Handle('account:folders', () => S.biliAccount.Folders());
  Handle('account:videos', (id, page) => S.biliAccount.Videos(id, page));
  Handle('bilibili:browse', () => S.biliBrowser.Open());
  Handle('bilibili:resolve', input => S.biliAccount.Resolve(input));
  Handle('bilibili:lists', input => S.biliAccount.Lists(input));
  Handle('bilibili:parts', input => S.biliAccount.Parts(input));
  Handle('bilibili:list-videos', (source, page) => S.biliAccount.ListVideos(source, page));
  Handle('app:release-open', () => shell.openExternal(DriveURL(S.store.data.settings.releaseDriveURL)));
  Handle('app:help', () => OpenHelp('GUIDE.html'));
  Handle('app:discord-portal', () => shell.openExternal('https://discord.com/developers/applications'));
  Handle('app:discord-guide', () => OpenHelp('DISCORD.html'));
  Handle('app:discord-image', () => shell.showItemInFolder(path.join(Resources('docs'), 'favecus_player_music.png')));
  Handle('app:taskbar-guide', () => OpenHelp('TASKBAR.html'));
};
