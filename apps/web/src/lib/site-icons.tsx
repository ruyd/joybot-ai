import {
  Award, Bot, Brain, Briefcase, Building, Calendar, CircleCheck, Clock, Cloud, Code, Compass, CreditCard, FileText, Gift, Globe, Handshake, Headphones, Heart, Layers,
  LayoutDashboard, Leaf, LifeBuoy, Lightbulb, Lock, Mail, MapPin, MessageCircle, Palette, Phone, Puzzle, Receipt, Repeat, Rocket, Search, Server, Settings, ShieldCheck,
  Smartphone, Sparkles, Star, Store, Target, TrendingUp, User, Users, Wallet, Wrench, Zap, type LucideIcon,
} from 'lucide-react';

/** Card icons by name; the names match the API's SITE_ICONS, so pages hold names, never SVG. */
export const SITE_ICONS = {
  sparkles: Sparkles, bot: Bot, brain: Brain, 'message-circle': MessageCircle, 'shield-check': ShieldCheck, lock: Lock, users: Users, user: User, building: Building, store: Store,
  calendar: Calendar, clock: Clock, 'credit-card': CreditCard, wallet: Wallet, receipt: Receipt, 'life-buoy': LifeBuoy, headphones: Headphones, globe: Globe, layout: LayoutDashboard, code: Code,
  smartphone: Smartphone, cloud: Cloud, server: Server, palette: Palette, wrench: Wrench, rocket: Rocket, briefcase: Briefcase, 'check-circle': CircleCheck, star: Star, zap: Zap,
  'trending-up': TrendingUp, heart: Heart, search: Search, 'file-text': FileText, 'map-pin': MapPin, phone: Phone, mail: Mail, settings: Settings, layers: Layers, puzzle: Puzzle,
  handshake: Handshake, award: Award, target: Target, lightbulb: Lightbulb, compass: Compass, repeat: Repeat, gift: Gift, leaf: Leaf,
} satisfies Record<string, LucideIcon>;

export type SiteIconName = keyof typeof SITE_ICONS;

export function SiteIcon({ name, className = 'size-5' }: { name: string; className?: string }) {
  const Icon = SITE_ICONS[name as SiteIconName];
  return Icon ? <Icon className={className} strokeWidth={1.8} aria-hidden="true" /> : null;
}
