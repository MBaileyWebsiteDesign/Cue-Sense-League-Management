      seedSummary.push({
        divisionId: sourceDivision.id,
        divisionName: sourceDivision.name,
        requested: Number(count),
        available: rankedIds.length,
        added,
      });
    }

    return { ...hydrateDivision(division), seedSummary };
  }),
