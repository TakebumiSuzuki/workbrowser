import type { Plan } from '../src/shared/contracts';

/** Deterministic local simulator. It makes no external model calls and never receives page content. */
export function mockPlan(prompt: string, url: string): Plan {
  const steps: Plan['steps'] = [];
  const add = (tool: Plan['steps'][number]['tool'], args: Record<string, unknown>, label: string) => steps.push({ tool, args, label });
  const clicked = prompt.match(/[「"]([^「」"]+)[」"](?:を|ボタンを)?(?:クリック|押)/);
  const filled = prompt.match(/[「"]([^「」"]+)[」"]に[「"]([^「」"]*)[」"](?:を)?(?:入力|設定)/);
  const batch = prompt.match(/(\d+)件/);
  if (batch && /処理/.test(prompt) && new URL(url).pathname === '/demo') {
    const count = Math.min(Number(batch[1]), 100);
    if (count < 1) throw new Error('件数は1〜100件にしてください');
    for (let i = 1; i <= count; i++) {
      const name = `顧客 ${String(i).padStart(3, '0')}`;
      add('click', { target: { role: 'button', name }, observe: 'none' }, `${name}を開く`);
      add('click', { target: { role: 'button', name: '処理済みにする' }, observe: 'none', expect: { text: `${name}を処理しました` } }, `${name}を処理する`);
    }
    add('read', { format: 'text', maxChars: 20000 }, '処理結果を取得');
  } else if (filled) {
    add('set', { target: { role: 'textbox', name: filled[1] }, value: filled[2], observe: 'none' }, `${filled[1]}に入力`);
  } else if (clicked) {
    add('click', { target: { role: 'button', name: clicked[1] }, observe: 'full' }, `${clicked[1]}をクリック`);
  } else if (/スクロール/.test(prompt)) {
    add('scroll', { by: { pages: 1 }, observe: 'none' }, '1ページ分スクロール');
  } else if (/読|取得|抽出/.test(prompt)) {
    add('read', { format: 'text', maxChars: 20000 }, 'ページのテキストを取得');
  } else {
    return { mode: 'mock', message: '模擬モードです。「ページのテキストを取得」「「検索」に「東京」を入力」「「検索する」をクリック」、デモ画面では「100件を順番に処理」を試せます。自由な指示の解釈は実モデル接続後に利用できます。', steps: [] };
  }
  return { mode: 'mock', message: `${steps.length}ステップの模擬プランを実行します。`, steps };
}
