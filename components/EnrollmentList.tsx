"use client";

import Link from "next/link";
import useSWR from "swr";
import { Button, buttonVariants } from "@/components/ui/button";
import type { Course, Enrollment } from "@/lib/courses";

const API = process.env.NEXT_PUBLIC_API_URL;

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export function EnrollmentList() {
  const { data, error, isLoading, isValidating, mutate } = useSWR<Enrollment[]>(
    API ? `${API}/enrollments` : null,
    fetcher<Enrollment[]>,
    { refreshInterval: 5000 },
  );
  const { data: courses } = useSWR<Course[]>(
    API ? `${API}/courses` : null,
    fetcher<Course[]>,
  );
  const courseTitles = new Map(courses?.map((course) => [course.id, course.title]));

  if (!API) {
    return <p role="alert">NEXT_PUBLIC_API_URL is not set: create .env.local</p>;
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--muted-foreground)]" role="status">
          {data
            ? `${data.length} ${data.length === 1 ? "enrollment" : "enrollments"}`
            : isLoading ? "Loading enrollments..." : "Enrollment records"}
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={isValidating}
          aria-busy={isValidating}
          onClick={() => void mutate()}
        >
          Refresh
        </Button>
      </div>

      {error && (
        <p role="alert" className="mb-6 text-red-600">
          Could not load enrollments. Check that the backend is running, then refresh.
        </p>
      )}
      {isLoading && <p role="status">Loading...</p>}

      {data && data.length === 0 && (
        <div className="rounded-xl border p-6">
          <h2 className="text-xl font-semibold">No enrollments yet</h2>
          <p className="mb-5 mt-2 text-[var(--muted-foreground)]">
            Choose a course and submit the enrollment form to see the record here.
          </p>
          <Link href="/courses" className={buttonVariants({ variant: "accent" })}>
            Browse courses
          </Link>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Course enrollment records</caption>
            <thead className="bg-[var(--muted)]">
              <tr>
                <th scope="col" className="px-4 py-3">Number</th>
                <th scope="col" className="px-4 py-3">Student</th>
                <th scope="col" className="px-4 py-3">Course</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.map((enrollment) => (
                <tr key={enrollment.id}>
                  <td className="px-4 py-4 font-medium">#{enrollment.id}</td>
                  <td className="px-4 py-4">{enrollment.studentName}</td>
                  <td className="px-4 py-4">
                    <Link
                      href={`/courses/${encodeURIComponent(enrollment.courseId)}`}
                      className="font-medium text-brand hover:underline"
                    >
                      {courseTitles.get(enrollment.courseId) ?? enrollment.courseId}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
