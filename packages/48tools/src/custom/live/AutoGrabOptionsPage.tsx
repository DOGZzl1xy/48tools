import type { OpenDialogReturnValue } from 'electron';
import { useEffect, useState, type ReactElement, type Dispatch as D, type SetStateAction as S } from 'react';
import { useDispatch } from 'react-redux';
import type { Dispatch } from '@reduxjs/toolkit';
import { App, Button, Input, InputNumber, Select, Space, Switch, Typography } from 'antd';
import type { useAppProps } from 'antd/es/app/context';
import { FolderOpenOutlined as IconFolderOpenOutlined } from '@ant-design/icons';
import '../settings/settings.global.sass';
import ButtonLink from '../../components/ButtonLink/ButtonLink';
import { showOpenDialog } from '../../utils/remote/dialog';
import { IDBSavePocket48LiveOptions } from '../../pages/48/reducers/pocket48';
import type { Pocket48LiveAutoGrabOptions } from '../../pages/48/types';
import { backButtonProps } from '../theme/backButton';
import Row from '../settings/SettingsRow';
import { useSettingOverrides, resolveSetting, setSetting, type CustomSettings } from '../settings/settingsStore';
import { useRoomState, type RoomState, type RoomMember } from '../room/roomStore';
import { useMemberDirectory, loadMemberDirectory, type DirectoryState } from '../room/memberDirectory';
import { teamLabel, type DirectoryMember } from '../room/memberSearch';
import { getLiveRecordDir, getLiveRecordFormat } from './liveRecording';
import { AUTO_GRAB_OPTIONS_NAME, parseAutoGrabUsers, readAutoGrabOptions } from './autoGrabRunner';

/**
 * 「自动抓取配置」页面（代替原版的 pages/48/Pocket48/LiveOptions，原版文件保留不动）。
 * 原版要手打成员的名字或 ID、用逗号分隔；这里改成从成员名单里选（可以按名字、拼音、队伍搜），选中的显示成标签。
 * 名单里没有的名字或 ID 在下面的小输入框里加（和选人分开，免得打了拼音一回车把拼音本身加进去）。
 * 「一键加入关注的成员」把房间消息里关注的成员都加进来。
 * 保存的格式和原版一样（成员仍然是逗号分隔的一段文字，从名单里选的存成员 ID——按 ID 匹配最准），所以原版的抓取代码不用改。
 * 保存目录：设置页（或 local/pocket48.json）里指定了直播录制文件夹时用那个，这里就不用填。
 * 接入点：pages/48/Index.tsx 的 LiveOptions 路由。
 */
const formatText: Record<string, string> = {
  flv: '保持 flv',
  mp4: '录完后转成 mp4（无损）',
  'mp4-compress': '录完后压缩成 mp4'
};

function AutoGrabOptionsPage(props: {}): ReactElement {
  const dispatch: Dispatch = useDispatch();
  const { message: messageApi }: useAppProps = App.useApp();
  const directory: DirectoryState = useMemberDirectory();
  const roomState: RoomState = useRoomState();
  const overrides: CustomSettings = useSettingOverrides();
  const [time, setTime]: [number, D<S<number>>] = useState(1);
  const [users, setUsers]: [Array<string>, D<S<Array<string>>>] = useState<Array<string>>([]);
  const [dir, setDir]: [string, D<S<string>>] = useState('');
  const [loaded, setLoaded]: [boolean, D<S<boolean>>] = useState(false);
  const [dirty, setDirty]: [boolean, D<S<boolean>>] = useState(false);
  const [custom, setCustom]: [string, D<S<string>>] = useState(''); // 名单里没有的名字或 ID
  const actualDir: string = getLiveRecordDir(dir);
  const fixedDir: boolean = Boolean(resolveSetting(overrides, 'liveRecordDir') || resolveSetting(overrides, 'downloadDir'));

  useEffect(function(): void {
    loadMemberDirectory();
    readAutoGrabOptions().then((value: Pocket48LiveAutoGrabOptions | undefined): void => {
      if (value) {
        setTime(Math.max(1, Number(value.time) || 1));
        setUsers(parseAutoGrabUsers(value.users));
        setDir(value.dir ?? '');
      } else {
        setDirty(true); // 还没有保存过配置
      }

      setLoaded(true);
    });
  }, []);

  /* 选项：名单里的每个成员（值是成员 ID）。已经填了但名单里没有的，原样显示 */
  const options: Array<{ value: string; label: string; search: string }> = directory.members.map(
    (member: DirectoryMember): { value: string; label: string; search: string } => {
      const team: string = teamLabel(member.team);

      return {
        value: String(member.id),
        label: team ? `${ member.name } · ${ team }` : member.name,
        search: `${ member.name } ${ (member.pinyin ?? '').replace(/\s+/g, '') } ${ member.pinyin ?? '' } ${ team } ${ member.id }`.toLowerCase()
      };
    });

  // 已经填了、但名单里没有的（手打的名字，或者名单还没取到）：也要能显示成标签
  const known: Set<string> = new Set(options.map((item: { value: string }): string => item.value));
  const allOptions: Array<{ value: string; label: string; search: string }> = [
    ...options,
    ...users
      .filter((user: string): boolean => !known.has(user))
      .map((user: string): { value: string; label: string; search: string } => ({ value: user, label: user, search: user.toLowerCase() }))
  ];

  function handleAddCustom(): void {
    const added: Array<string> = parseAutoGrabUsers(custom).filter((item: string): boolean => !users.includes(item));

    if (added.length > 0) {
      setUsers([...users, ...added]);
      setDirty(true);
    }

    setCustom('');
  }

  function handleUsersChange(value: Array<string>): void {
    setUsers(value.map((item: string): string => item.trim()).filter((item: string): boolean => item !== ''));
    setDirty(true);
  }

  function handleAddFollowsClick(): void {
    const next: Array<string> = [...users];

    for (const member of roomState.follows) {
      // 已经按 ID 或者按名字填过的不重复加
      if (!next.includes(String(member.ownerId)) && !next.includes(member.name)) next.push(String(member.ownerId));
    }

    setUsers(next);
    setDirty(true);
  }

  async function handleChooseDirClick(): Promise<void> {
    const result: OpenDialogReturnValue = await showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });

    if (result.canceled || !result.filePaths?.length) return;

    setDir(result.filePaths[0]);
    setDirty(true);
  }

  async function handleSaveClick(): Promise<void> {
    if (users.length === 0) {
      messageApi.warning('先选至少一个成员');

      return;
    }

    if (!actualDir) {
      messageApi.warning('先选一个保存录像的文件夹');

      return;
    }

    const value: Pocket48LiveAutoGrabOptions = { time, users: users.join(','), dir: dir || actualDir };

    await dispatch(IDBSavePocket48LiveOptions({ data: { name: AUTO_GRAB_OPTIONS_NAME, value } }));
    setDirty(false);
    messageApi.success('已保存。正在运行的自动抓取要停止后重新开始才会用新的配置。');
  }

  return (
    <div className="settings">
      <h1>自动抓取配置</h1>
      <section>
        <h2>监听谁</h2>
        <Row label="成员" hint="这些成员一开播就记下来，直播结束后下载录播、切片（开始自动抓取时勾选要什么）。可以按名字、拼音、队伍（比如 NII）搜索。">
          <Select className="w-full"
            mode="multiple"
            allowClear={ true }
            placeholder={ loaded ? '搜索并选择成员' : '正在读取配置…' }
            disabled={ !loaded }
            value={ users }
            options={ allOptions }
            optionFilterProp="search"
            onChange={ handleUsersChange }
          />
          <Space className="mt-[8px]" wrap={ true }>
            <Button size="small" disabled={ roomState.follows.length === 0 } onClick={ handleAddFollowsClick }>
              一键加入关注的成员（{ roomState.follows.map((member: RoomMember): string => member.name).join('、') || '还没有关注' }）
            </Button>
            <Typography.Text type="secondary">已选 { users.length } 个</Typography.Text>
          </Space>
          <Space.Compact className="mt-[8px] w-full">
            <Input value={ custom }
              placeholder="名单里没有的：输入名字或成员 ID（多个用逗号隔开）"
              onChange={ (event: { target: { value: string } }): void => setCustom(event.target.value) }
              onPressEnter={ handleAddCustom }
            />
            <Button disabled={ custom.trim() === '' } onClick={ handleAddCustom }>加入</Button>
          </Space.Compact>
        </Row>
        <Row label="多久检查一次" hint="每隔这么多分钟看一次直播列表。">
          <Space>
            <InputNumber min={ 1 }
              max={ 60 }
              value={ time }
              onChange={ (value: number | null): void => {
                setTime(Math.max(1, value ?? 1));
                setDirty(true);
              } }
            />
            分钟
          </Space>
        </Row>
      </section>

      <section>
        <h2>存到哪里</h2>
        <Row label="保存文件夹"
          hint={ fixedDir
            ? '设置页里已经指定了直播录制的文件夹，下载的录播和弹幕保存在那里，这里不用选。要改请到「设置 → 保存位置」。'
            : '直播结束后下载的录播和弹幕保存在这里（切片保存在「录播切片」的位置）。也可以在「设置 → 保存位置」里统一指定。' }
        >
          {
            fixedDir ? (
              <Typography.Text>{ actualDir }</Typography.Text>
            ) : (
              <Space.Compact className="w-full">
                <Input readOnly={ true } value={ dir } placeholder="还没有选" />
                <Button icon={ <IconFolderOpenOutlined /> } onClick={ handleChooseDirClick }>选择</Button>
              </Space.Compact>
            )
          }
          <Typography.Text className="block mt-[6px] text-[12px]" type="secondary">
            自动抓取不录直播流，下载的是官方录播（mp4；电台是 m4a 录音加一张 jpg 封面）。页面上手动点「录制」录下来的直播，录完后的格式：
            { formatText[getLiveRecordFormat()] ?? '保持 flv' }（在「设置 → 保存位置」里改）
          </Typography.Text>
        </Row>
      </section>

      <section>
        <h2>什么时候开始</h2>
        <Row label="启动后自动开始" hint="程序启动几秒后自动开始监听。关掉后要到「直播抓取」页面手动点「开始自动抓取」。">
          <Switch checked={ resolveSetting(overrides, 'autoGrabAutoStart') !== false }
            onChange={ (checked: boolean): void => setSetting('autoGrabAutoStart', checked ? undefined : false) }
          />
        </Row>
      </section>

      <Space className="mt-[20px]">
        <ButtonLink linkProps={{ to: '/48/Pocket48Live' }} buttonProps={ backButtonProps }>返回</ButtonLink>
        <Button type="primary" disabled={ !loaded } onClick={ handleSaveClick }>{ dirty ? '保存' : '已保存' }</Button>
      </Space>
    </div>
  );
}

export default AutoGrabOptionsPage;
