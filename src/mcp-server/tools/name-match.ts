interface Named {
    name?: string;
}

export function isExactNameMatch(entity: Named, name: string): boolean {
    return (entity.name ?? "").toLowerCase() === name.toLowerCase();
}

/**
 * Returned lists are capped, so without this an exactly-named entity past the
 * cap would be silently dropped from a broad query's response. Relies on
 * Array.prototype.sort being stable (guaranteed since ES2019) to keep API
 * order for the rest.
 */
export function moveExactMatchToTop<T extends Named>(
    entities: T[],
    name: string,
): T[] {
    return entities
        .slice()
        .sort(
            (a, b) =>
                Number(isExactNameMatch(b, name)) -
                Number(isExactNameMatch(a, name)),
        );
}
