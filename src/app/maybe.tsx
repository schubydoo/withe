/**
 * A link, or the same text unlinked when nothing can be addressed.
 *
 * Every list page builds addresses from what a source reported, and a source
 * that never named its forge leaves them null. Rendering the text unlinked
 * keeps the cell readable instead of showing a dead link or a blank.
 */
export function Maybe({
  href,
  children,
  title,
}: {
  href: string | null;
  children: React.ReactNode;
  title?: string;
}) {
  if (!href) return <>{children}</>;
  return (
    <a
      className="underline decoration-neutral-300 dark:decoration-neutral-700 hover:decoration-neutral-600"
      href={href}
      title={title}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}
