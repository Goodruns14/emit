"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.diffCatalogs = diffCatalogs;
/**
 * Compare two catalogs and produce a structured diff.
 * If base is null (first scan), all head events are "added".
 */
function diffCatalogs(base, head) {
    const baseEvents = base?.events ?? {};
    const headEvents = head.events;
    const added = [];
    const removed = [];
    const modified = [];
    const low_confidence = [];
    // Detect added and modified events
    for (const [name, headEvent] of Object.entries(headEvents)) {
        const baseEvent = baseEvents[name];
        // Collect low-confidence warnings from head
        if (headEvent.confidence === "low") {
            low_confidence.push({
                event: name,
                confidence_reason: headEvent.confidence_reason,
                source_file: headEvent.source_file,
                source_line: headEvent.source_line,
            });
        }
        for (const [propName, prop] of Object.entries(headEvent.properties)) {
            if (prop.confidence === "low") {
                low_confidence.push({
                    event: name,
                    property: propName,
                    confidence_reason: `Low confidence property`,
                    source_file: headEvent.source_file,
                    source_line: headEvent.source_line,
                });
            }
        }
        if (!baseEvent) {
            added.push(buildEventChange(name, headEvent, "added"));
            continue;
        }
        // Compare fields
        const fieldsChanged = diffEventFields(baseEvent, headEvent);
        const propertyChanges = diffProperties(baseEvent.properties, headEvent.properties);
        if (fieldsChanged.length > 0 || propertyChanges.length > 0) {
            modified.push({
                event: name,
                type: "modified",
                description: headEvent.description,
                previous_description: fieldsChanged.includes("description") ? baseEvent.description : undefined,
                confidence: headEvent.confidence,
                confidence_changed: baseEvent.confidence !== headEvent.confidence,
                previous_confidence: baseEvent.confidence !== headEvent.confidence ? baseEvent.confidence : undefined,
                property_changes: propertyChanges,
                fields_changed: fieldsChanged,
            });
        }
    }
    // Detect removed events
    for (const [name, baseEvent] of Object.entries(baseEvents)) {
        if (!headEvents[name]) {
            removed.push(buildEventChange(name, baseEvent, "removed"));
        }
    }
    return { added, removed, modified, low_confidence };
}
function buildEventChange(name, event, type) {
    return {
        event: name,
        type,
        description: event.description,
        confidence: event.confidence,
        confidence_changed: false,
        property_changes: [],
        fields_changed: [],
    };
}
const EVENT_COMPARE_FIELDS = [
    "description",
    "fires_when",
    "confidence",
];
function diffEventFields(base, head) {
    const changed = [];
    for (const field of EVENT_COMPARE_FIELDS) {
        if (base[field] !== head[field]) {
            changed.push(field);
        }
    }
    return changed;
}
function diffProperties(baseProps, headProps) {
    const changes = [];
    for (const [name, headProp] of Object.entries(headProps)) {
        const baseProp = baseProps[name];
        if (!baseProp) {
            changes.push({ property: name, type: "added", after: headProp.description });
            continue;
        }
        if (baseProp.description !== headProp.description) {
            changes.push({
                property: name,
                type: "modified",
                before: baseProp.description,
                after: headProp.description,
            });
        }
    }
    for (const name of Object.keys(baseProps)) {
        if (!headProps[name]) {
            changes.push({ property: name, type: "removed", before: baseProps[name].description });
        }
    }
    return changes;
}
//# sourceMappingURL=index.js.map