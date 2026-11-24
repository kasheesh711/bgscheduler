export default function MemePage() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="max-w-2xl rounded-2xl border bg-card p-10 text-center shadow-sm">
        <p className="text-sm uppercase tracking-widest text-muted-foreground">
          Breaking news
        </p>
        <h1 className="mt-4 text-5xl font-extrabold tracking-tight sm:text-6xl">
          Kevin is the best
        </h1>
        <p className="mt-6 text-lg text-muted-foreground">
          This is a test page. If you can read this, the deploy works. 🎉
        </p>
      </div>
    </div>
  );
}
