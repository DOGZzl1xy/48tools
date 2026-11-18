import {
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
  type KeyboardEvent,
  type Dispatch as D,
  type SetStateAction as S
} from 'react';
import { useNavigate, type NavigateFunction } from 'react-router';
import { Modal, Input, type InputRef } from 'antd';
import { SearchOutlined as IconSearchOutlined, HomeOutlined as IconHomeOutlined } from '@ant-design/icons';
import { shellNavGroups, type ShellNavGroup, type ShellNavItem } from './navConfig';
import { useShellState, setPaletteOpen, type ShellState } from './shellStore';

/**
 * 快速跳转（Ctrl+K）：输入功能名字的一部分，回车直接进入；上下键选择，Esc 关闭。
 * 由 AppShell 渲染，开关状态在 shellStore。
 */
interface PaletteEntry {
  item: ShellNavItem;
  group: string;
  search: string;
}

const entries: Array<PaletteEntry> = [
  {
    item: { key: 'home', label: '主页', title: '主页', to: '/', icon: <IconHomeOutlined /> },
    group: '',
    search: '主页 home 设置'
  },
  ...shellNavGroups.flatMap((group: ShellNavGroup): Array<PaletteEntry> => group.items.map((item: ShellNavItem): PaletteEntry => ({
    item,
    group: group.title,
    search: `${ item.title } ${ item.label } ${ group.title } ${ item.to }`.toLowerCase()
  })))
];

function CommandPalette(props: {}): ReactElement {
  const { paletteOpen }: ShellState = useShellState();
  const navigate: NavigateFunction = useNavigate();
  const [keyword, setKeyword]: [string, D<S<string>>] = useState('');
  const [index, setIndex]: [number, D<S<number>>] = useState(0);
  const inputRef: RefObject<InputRef | null> = useRef(null);
  const results: Array<PaletteEntry> = useMemo(function(): Array<PaletteEntry> {
    const words: Array<string> = keyword.toLowerCase().split(/\s+/).filter(Boolean);

    return entries.filter((entry: PaletteEntry): boolean => words.every((word: string): boolean => entry.search.includes(word)));
  }, [keyword]);

  function handleClose(): void {
    setPaletteOpen(false);
    setKeyword('');
    setIndex(0);
  }

  function handleGo(entry: PaletteEntry | undefined): void {
    if (!entry) return;

    navigate(entry.item.to);
    handleClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((prev: number): number => Math.min(results.length - 1, prev + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((prev: number): number => Math.max(0, prev - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      handleGo(results[Math.min(index, results.length - 1)]);
    }
  }

  return (
    <Modal open={ paletteOpen }
      width={ 520 }
      footer={ null }
      closable={ false }
      destroyOnHidden={ true }
      styles={{ body: { padding: 0 } }}
      style={{ top: 120 }}
      afterOpenChange={ (open: boolean): void => {
        open && inputRef.current?.focus(); // 弹窗打开后把光标放进输入框，可以直接打字
      } }
      onCancel={ handleClose }
    >
      <Input ref={ inputRef }
        size="large"
        variant="borderless"
        autoFocus={ true }
        placeholder="输入功能名字，回车进入"
        prefix={ <IconSearchOutlined /> }
        value={ keyword }
        onChange={ (event: { target: { value: string } }): void => {
          setKeyword(event.target.value);
          setIndex(0);
        } }
        onKeyDown={ handleKeyDown }
      />
      <div className="shell-palette-list">
        {
          results.map((entry: PaletteEntry, i: number): ReactElement => (
            <div key={ entry.item.key }
              className={ `shell-palette-item${ i === Math.min(index, results.length - 1) ? ' is-active' : '' }` }
              role="option"
              aria-selected={ i === index }
              onMouseEnter={ (): void => setIndex(i) }
              onClick={ (): void => handleGo(entry) }
            >
              { entry.item.icon }
              <span>{ entry.item.title }</span>
              <small>{ entry.group }</small>
            </div>
          ))
        }
        { results.length === 0 ? <div className="shell-palette-item"><span>没有找到匹配的功能</span></div> : null }
      </div>
    </Modal>
  );
}

export default CommandPalette;
