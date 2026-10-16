import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="text-center">
        <h1 className="text-lg font-semibold">Not found</h1>
        <p className="mt-1 text-sm text-ink-muted">This record doesn’t exist or isn’t in your data scope.</p>
        <Link href="/" className="mt-3 inline-block text-sm text-brand hover:underline">Go home</Link>
      </div>
    </div>
  );
}
