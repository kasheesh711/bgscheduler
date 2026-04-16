"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SearchResponse, TutorResult, TutorReviewResult, SlotResult } from "@/lib/search/types";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface ResultsViewProps {
  response: SearchResponse;
}

export function ResultsView({ response }: ResultsViewProps) {
  const { perSlotResults, intersection, snapshotMeta, latencyMs, warnings } = response;

  return (
    <div className="space-y-4">
      {/* Metadata banner */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Snapshot: {snapshotMeta.snapshotId.slice(0, 8)}... | Synced:{" "}
          {new Date(snapshotMeta.syncedAt).toLocaleString()} | {latencyMs}ms
        </span>
        {snapshotMeta.stale && (
          <Badge variant="destructive">Stale Data</Badge>
        )}
      </div>

      {warnings.map((w, i) => (
        <div key={i} className="rounded-md bg-accent/60 p-2 text-sm text-accent-foreground">
          {w}
        </div>
      ))}

      <Tabs defaultValue={perSlotResults[0]?.slotId ?? "intersection"}>
        <TabsList>
          {perSlotResults.map((sr, i) => {
            const slot = response.normalizedSlots[i];
            const label = slot?.dayOfWeek !== undefined
              ? `${WEEKDAY_NAMES[slot.dayOfWeek]} ${slot.start}-${slot.end}`
              : `${slot?.date} ${slot?.start}-${slot?.end}`;
            return (
              <TabsTrigger key={sr.slotId} value={sr.slotId}>
                {label} ({sr.available.length})
              </TabsTrigger>
            );
          })}
          {perSlotResults.length > 1 && (
            <TabsTrigger value="intersection">
              Intersection ({intersection.length})
            </TabsTrigger>
          )}
        </TabsList>

        {perSlotResults.map((sr) => (
          <TabsContent key={sr.slotId} value={sr.slotId}>
            <SlotResultView result={sr} />
          </TabsContent>
        ))}

        {perSlotResults.length > 1 && (
          <TabsContent value="intersection">
            <Card>
              <CardHeader>
                <CardTitle>Available in All Slots ({intersection.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <TutorTable tutors={intersection} />
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function SlotResultView({ result }: { result: SlotResult }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Available ({result.available.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <TutorTable tutors={result.available} />
        </CardContent>
      </Card>

      {result.needsReview.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Needs Review ({result.needsReview.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ReviewTable tutors={result.needsReview} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TutorTable({ tutors }: { tutors: TutorResult[] }) {
  if (tutors.length === 0) {
    return <p className="text-sm text-muted-foreground">No tutors available</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Tutor</TableHead>
          <TableHead>Modes</TableHead>
          <TableHead>Qualifications</TableHead>
          <TableHead>Wise Records</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tutors.map((t) => (
          <TableRow key={t.tutorGroupId}>
            <TableCell className="font-medium">{t.displayName}</TableCell>
            <TableCell>
              <div className="flex gap-1">
                {t.supportedModes.map((m) => (
                  <Badge key={m} variant="outline">{m}</Badge>
                ))}
              </div>
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {t.qualifications.slice(0, 3).map((q, i) => (
                  <Badge key={i} variant="secondary" className="text-xs">
                    {q.subject} {q.curriculum} {q.level}
                  </Badge>
                ))}
                {t.qualifications.length > 3 && (
                  <Badge variant="secondary" className="text-xs">
                    +{t.qualifications.length - 3}
                  </Badge>
                )}
              </div>
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {t.underlyingWiseRecords.map((r) => r.wiseDisplayName).join(", ")}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ReviewTable({ tutors }: { tutors: TutorReviewResult[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Tutor</TableHead>
          <TableHead>Reasons</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tutors.map((t) => (
          <TableRow key={t.tutorGroupId}>
            <TableCell className="font-medium">{t.displayName}</TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {t.reasons.map((r, i) => (
                  <Badge key={i} variant="destructive" className="text-xs">
                    {r.split(":")[0]}
                  </Badge>
                ))}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
