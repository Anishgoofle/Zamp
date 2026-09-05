import type { ReactNode } from 'react';

/** A titled panel card. `aside` sits next to the heading (a status tag, say). */
export function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <h2>
        {title}
        {aside}
      </h2>
      {children}
    </section>
  );
}
