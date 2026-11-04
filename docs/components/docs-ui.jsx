import Link from 'next/link';
import { ArrowUpRight, BookOpen, Command, Layers, NotebookPen, ShieldCheck, SquareTerminal } from 'lucide-react';

const icons = { terminal: SquareTerminal, commands: Command, memory: NotebookPen, planning: Layers, permissions: ShieldCheck };

export function DocsIntro() {
  return <div className="pi-intro">
    <h1>Not really a minimalistic harness.</h1>
    <p>A focused coding agent for your terminal.<br className="pi-intro-break" /> Clear tools, project memory, and plans you can review.</p>
    <div className="pi-intro-links"><Link href="/getting-started/installation">Get started <ArrowUpRight size={15} aria-hidden="true" /></Link><Link href="/reference/commands">Explore the commands <ArrowUpRight size={15} aria-hidden="true" /></Link></div>
  </div>;
}

export function CardGrid({ children }) { return <div className="pi-card-grid">{children}</div>; }

export function DocCard({ href, icon = 'terminal', title, badge, children }) {
  const Icon = icons[icon] ?? BookOpen;
  return <Link href={href} className="pi-doc-card">
    <span className="pi-card-top"><span className="pi-card-icon"><Icon size={20} strokeWidth={1.6} aria-hidden="true" /></span><ArrowUpRight className="pi-card-arrow" size={16} strokeWidth={1.6} aria-hidden="true" /></span>
    <span className="pi-card-heading"><strong>{title}</strong>{badge && <span className="pi-version">{badge}</span>}</span>
    <div className="pi-card-description">{children}</div>
  </Link>;
}
