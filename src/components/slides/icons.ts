// Small keyword -> pictogram heuristic for diagram/network-graph visual
// elements (notes-slide-quality.md §2 "シンプルな単色ピクトグラム...を多用").
// Source content is arbitrary, so this is best-effort: it scans a node/icon
// element's label for common tech/business keywords (English + Japanese) and
// falls back to a neutral shape when nothing matches. Not meant to be
// exhaustive — just enough to make generated diagrams look considered
// instead of a wall of identical boxes.
import {
  Boxes,
  Cpu,
  Database,
  GitBranch,
  Globe,
  HardDrive,
  Image as ImageIcon,
  Layers,
  Link2,
  Lock,
  MessageCircle,
  Monitor,
  Network,
  Puzzle,
  Radio,
  Route,
  Server,
  Shield,
  Smartphone,
  TreePine,
  Users,
  Waypoints,
  Wifi,
  Workflow,
  Zap,
  type LucideProps,
} from 'lucide-preact'
import type { FunctionComponent } from 'preact'

export type PictogramIcon = FunctionComponent<LucideProps>

const KEYWORD_ICONS: Array<[RegExp, PictogramIcon]> = [
  [/user|client|人|ユーザ|参加者|クライアント/i, Users],
  [/server|サーバ/i, Server],
  [/database|db|データベース|保存|ストレージ|storage/i, Database],
  [/network|ネットワーク|topology|トポロジ/i, Network],
  [/node|ノード/i, Waypoints],
  [/security|secur|セキュリティ|暗号|encrypt|認証|auth/i, Shield],
  [/lock|access|権限|許可/i, Lock],
  [/route|routing|経路|ルーティング|ルート/i, Route],
  [/link|接続|connect|connection/i, Link2],
  [/wifi|wireless|無線/i, Wifi],
  [/radio|signal|信号|電波/i, Radio],
  [/mobile|phone|スマホ|端末/i, Smartphone],
  [/screen|display|画面|表示|monitor/i, Monitor],
  [/cpu|process|処理|演算/i, Cpu],
  [/disk|file|ファイル|保管/i, HardDrive],
  [/layer|階層|層/i, Layers],
  [/tree|hierarchy|階層構造|ツリー/i, TreePine],
  [/branch|分岐|fork/i, GitBranch],
  [/flow|process|フロー|手順|workflow/i, Workflow],
  [/message|chat|通知|メッセージ|会話/i, MessageCircle],
  [/energy|power|速度|高速|fast|latency/i, Zap],
  [/global|world|世界|グローバル|internet/i, Globe],
  [/image|photo|画像|写真|screenshot/i, ImageIcon],
  [/module|component|部品|要素|piece/i, Puzzle],
  [/group|cluster|集合|グループ|box/i, Boxes],
]

/** Best-effort icon lookup for a diagram node/icon element's label. Always returns a component. */
export function getIconForLabel(label: string): PictogramIcon {
  for (const [pattern, Icon] of KEYWORD_ICONS) {
    if (pattern.test(label)) return Icon
  }
  return Boxes
}
