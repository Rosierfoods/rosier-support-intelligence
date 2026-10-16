import Link from 'next/link';
export const metadata = { title: 'Access restricted' };
export default function Forbidden() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="card max-w-md p-6 text-center">
        <h1 className="text-lg font-semibold">Access restricted</h1>
        <p className="mt-1 text-sm text-ink-muted">Your role doesn’t include access to this page. Ask a Super Admin if you need it.</p>
        <Link href="/" className="mt-4 inline-block text-sm text-brand hover:underline">Back to your home page</Link>
      </div>
    </div>
  );
}
