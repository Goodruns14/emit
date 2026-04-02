import { readCatalog } from "../../core/catalog/index.js";

export interface GetEventsBySourceFileInput {
  file_path: string;
}

export function getEventsBySourceFileTool(catalogPath: string, input: GetEventsBySourceFileInput) {
  try {
    const catalog = readCatalog(catalogPath);
    const q = input.file_path.toLowerCase();

    const events: Array<{
      name: string;
      description: string;
      fires_when: string;
      confidence: string;
      source_file: string;
      source_line: number;
      matching_call_sites: Array<{ file: string; line: number }>;
    }> = [];

    for (const [name, event] of Object.entries(catalog.events ?? {})) {
      const matchingSites = (event.all_call_sites ?? []).filter(
        (cs) => cs.file.toLowerCase().includes(q)
      );

      const primaryMatch = event.source_file?.toLowerCase().includes(q);

      if (primaryMatch || matchingSites.length > 0) {
        events.push({
          name,
          description: event.description,
          fires_when: event.fires_when,
          confidence: event.confidence,
          source_file: event.source_file,
          source_line: event.source_line,
          matching_call_sites: matchingSites,
        });
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            file_path: input.file_path,
            count: events.length,
            events,
          }),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        },
      ],
      isError: true as const,
    };
  }
}
