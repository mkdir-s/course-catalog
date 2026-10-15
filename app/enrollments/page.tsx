import { EnrollmentList } from "@/components/EnrollmentList";

export default function EnrollmentsPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold">Enrollments</h1>
      <p className="mb-8 mt-3 text-[var(--muted-foreground)]">
        Course enrollments submitted through the catalog. The list updates every five seconds.
        Records reset when the backend restarts.
      </p>
      <EnrollmentList />
    </main>
  );
}
