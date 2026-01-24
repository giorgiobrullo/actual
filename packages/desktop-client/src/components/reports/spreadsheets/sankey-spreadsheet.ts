// @ts-strict-ignore
import { send } from 'loot-core/platform/client/fetch';
import * as monthUtils from 'loot-core/shared/months';
import { q } from 'loot-core/shared/query';
import {
  type CategoryGroupEntity,
  type RuleConditionEntity,
} from 'loot-core/types/models';

import { type useSpreadsheet } from '@desktop-client/hooks/useSpreadsheet';
import { aqlQuery } from '@desktop-client/queries/aqlQuery';

type BudgetMonthCategory = {
  id: string;
  name: string;
  received?: number;
  spent?: number;
  budgeted?: number;
  balance?: number;
};

type BudgetMonthGroup = {
  id: string;
  name: string;
  is_income: boolean;
  categories: BudgetMonthCategory[];
};

// Helper function to filter category groups based on conditions
async function filterCategoryGroups(
  categoryGroups: BudgetMonthGroup[],
  conditions: RuleConditionEntity[],
  conditionsOp: 'and' | 'or',
  allCategories: CategoryGroupEntity[],
): Promise<BudgetMonthGroup[]> {
  // If no conditions, return all groups
  if (!conditions || conditions.length === 0) {
    return categoryGroups;
  }

  // Build a map of category IDs to check against filters
  const categoryIdToNameMap = new Map<string, string>();
  const categoryIdToGroupMap = new Map<string, string>();

  allCategories.forEach(group => {
    group.categories?.forEach(cat => {
      categoryIdToNameMap.set(cat.id, cat.name);
      categoryIdToGroupMap.set(cat.id, group.name);
    });
  });

  // Extract category-related conditions
  const categoryConditions = conditions.filter(
    cond => cond.field === 'category',
  );

  // If no category conditions, return all groups (other filters will be applied to transactions)
  if (categoryConditions.length === 0) {
    return categoryGroups;
  }

  // Function to check if a category matches the conditions
  const categoryMatchesConditions = (categoryId: string): boolean => {
    if (conditionsOp === 'or') {
      // For OR, category matches if it matches ANY condition
      return categoryConditions.some(cond => {
        if (cond.op === 'is') {
          return categoryId === cond.value;
        } else if (cond.op === 'isNot') {
          return categoryId !== cond.value;
        } else if (cond.op === 'oneOf') {
          return Array.isArray(cond.value) && cond.value.includes(categoryId);
        } else if (cond.op === 'notOneOf') {
          return !Array.isArray(cond.value) || !cond.value.includes(categoryId);
        }
        return true;
      });
    } else {
      // For AND, category matches if it matches ALL conditions
      return categoryConditions.every(cond => {
        if (cond.op === 'is') {
          return categoryId === cond.value;
        } else if (cond.op === 'isNot') {
          return categoryId !== cond.value;
        } else if (cond.op === 'oneOf') {
          return Array.isArray(cond.value) && cond.value.includes(categoryId);
        } else if (cond.op === 'notOneOf') {
          return !Array.isArray(cond.value) || !cond.value.includes(categoryId);
        }
        return true;
      });
    }
  };

  // Filter category groups and their categories
  const filteredGroups = categoryGroups
    .map(group => ({
      ...group,
      categories: group.categories.filter(cat =>
        categoryMatchesConditions(cat.id),
      ),
    }))
    .filter(group => group.categories.length > 0);

  return filteredGroups;
}

export function createSpreadsheet(
  start: string,
  end: string,
  categories: CategoryGroupEntity[],
  conditions: RuleConditionEntity[] = [],
  conditionsOp: 'and' | 'or' = 'and',
  mode: 'budgeted' | 'spent' | 'difference' = 'budgeted',
  grouped: boolean = true,
  sortBy: 'category' | 'value' | 'alphabetical' = 'category',
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: ReturnType<typeof transformToSankeyData>) => void,
  ) => {
    if (mode === 'budgeted') {
      const data = await createBudgetSpreadsheet(
        start,
        end,
        categories,
        conditions,
        conditionsOp,
        grouped,
        sortBy,
      )(spreadsheet, setData);
      return data;
    } else if (mode === 'spent') {
      const data = await createTransactionsSpreadsheet(
        start,
        end,
        categories,
        conditions,
        conditionsOp,
        grouped,
        sortBy,
      )(spreadsheet, setData);
      return data;
    } else {
      // mode === 'difference'
      const data = await createDifferenceSpreadsheet(
        start,
        end,
        categories,
        conditions,
        conditionsOp,
        grouped,
        sortBy,
      )(spreadsheet, setData);
      return data;
    }
  };
}

export function createBudgetSpreadsheet(
  start: string,
  end: string,
  categories: CategoryGroupEntity[],
  conditions: RuleConditionEntity[] = [],
  conditionsOp: 'and' | 'or' = 'and',
  grouped: boolean = true,
  sortBy: 'category' | 'value' | 'alphabetical' = 'category',
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: ReturnType<typeof transformToSankeyData>) => void,
  ) => {
    type BudgetMonthResponse = {
      categoryGroups: BudgetMonthGroup[];
      totalIncome: number;
      fromLastMonth: number;
      forNextMonth: number;
      toBudget: number;
    };

    // Get all months in the range
    const months = monthUtils.rangeInclusive(start, end);

    // Fetch budget data for all months
    const monthlyData = await Promise.all(
      months.map(async month => {
        const response = (await send('api/budget-month', {
          month,
        })) as unknown as BudgetMonthResponse;
        return { month, ...response };
      }),
    );

    // Aggregate data across all months
    const aggregatedIncomeData: Record<string, number> = {};
    const aggregatedCategoryData: Record<string, Record<string, number>> = {};
    let totalFromLastMonth = 0;
    let totalForNextMonth = 0;
    let totalToBudget = 0;

    for (const data of monthlyData) {
      const filteredCategoryGroups = await filterCategoryGroups(
        data.categoryGroups,
        conditions,
        conditionsOp,
        categories,
      );

      // Aggregate income data
      const incomeGroups = filteredCategoryGroups.filter(
        group => group.is_income === true,
      );
      for (const group of incomeGroups) {
        for (const cat of group.categories) {
          aggregatedIncomeData[group.name] =
            (aggregatedIncomeData[group.name] ?? 0) + (cat.received ?? 0);
        }
      }

      // Aggregate expense data
      const expenseGroups = filteredCategoryGroups.filter(
        group => group.is_income !== true,
      );
      for (const group of expenseGroups) {
        if (!aggregatedCategoryData[group.name]) {
          aggregatedCategoryData[group.name] = {};
        }
        for (const cat of group.categories) {
          aggregatedCategoryData[group.name][cat.name] =
            (aggregatedCategoryData[group.name][cat.name] ?? 0) +
            (cat.budgeted ?? 0);
        }
      }

      // Only count fromLastMonth for the first month
      if (data.month === start && data.fromLastMonth > 0) {
        totalFromLastMonth = data.fromLastMonth;
      }
      // Only count forNextMonth for the last month
      if (data.month === end && data.forNextMonth > 0) {
        totalForNextMonth = data.forNextMonth;
      }
      totalToBudget += data.toBudget;
    }

    if (totalFromLastMonth > 0) {
      aggregatedIncomeData['From Last Month'] = totalFromLastMonth;
    }

    // Convert aggregated data to the expected format
    const categoryData = Object.entries(aggregatedCategoryData).map(
      ([groupName, subcategories]) => ({
        name: groupName,
        balances: Object.entries(subcategories).map(([subcatName, value]) => ({
          subcategory: subcatName,
          value,
        })),
      }),
    );

    if (totalForNextMonth > 0) {
      categoryData.push({
        name: 'For Next Month',
        balances: [
          {
            subcategory: 'For Next Month',
            value: totalForNextMonth,
          },
        ],
      });
    }

    setData(
      transformToSankeyData(
        categoryData,
        aggregatedIncomeData,
        totalToBudget,
        'Available Funds',
        grouped,
        sortBy,
      ),
    );
  };
}

export function createTransactionsSpreadsheet(
  start: string,
  end: string,
  categories: CategoryGroupEntity[],
  conditions: RuleConditionEntity[] = [],
  conditionsOp: 'and' | 'or' = 'and',
  grouped: boolean = true,
  sortBy: 'category' | 'value' | 'alphabetical' = 'category',
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: ReturnType<typeof transformToSankeyData>) => void,
  ) => {
    // gather filters user has set
    const { filters } = await send('make-filters-from-conditions', {
      conditions: conditions.filter(cond => !cond.customName),
    });
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    // retrieve sum of subcategory expenses
    async function fetchCategoryData(categories) {
      try {
        return await Promise.all(
          categories.map(async mainCategory => {
            const subcategoryBalances = await Promise.all(
              mainCategory.categories
                .filter(subcategory => !subcategory?.is_income)
                .map(async subcategory => {
                  const results = await aqlQuery(
                    q('transactions')
                      .filter({
                        [conditionsOpKey]: filters,
                      })
                      .filter({
                        $and: [
                          { date: { $gte: monthUtils.firstDayOfMonth(start) } },
                          { date: { $lte: monthUtils.lastDayOfMonth(end) } },
                        ],
                      })
                      .filter({ category: subcategory.id })
                      .calculate({ $sum: '$amount' }),
                  );
                  return {
                    subcategory: subcategory.name,
                    value: results.data * -1,
                  };
                }),
            );

            // Here you could combine, reduce or transform the subcategoryBalances if needed
            return {
              name: mainCategory.name,
              balances: subcategoryBalances,
            };
          }),
        );
      } catch (error) {
        console.error('Error fetching category data:', error);
        throw error; // Re-throw if you want the error to propagate
      }
    }

    // create list of Income subcategories
    const allIncomeSubcategories = [].concat(
      ...categories
        .filter(category => category.is_income)
        .map(category => category.categories),
    );

    // retrieve all income subcategory payees
    async function fetchIncomeData() {
      // Map over allIncomeSubcategories and return an array of promises
      const promises = allIncomeSubcategories.map(subcategory => {
        return aqlQuery(
          q('transactions')
            .filter({
              [conditionsOpKey]: filters,
            })
            .filter({
              $and: [
                { date: { $gte: monthUtils.firstDayOfMonth(start) } },
                { date: { $lte: monthUtils.lastDayOfMonth(end) } },
              ],
            })
            .filter({ category: subcategory.id })
            .groupBy(['payee'])
            .select(['payee', { amount: { $sum: '$amount' } }]),
        );
      });

      // Use Promise.all() to wait for all queries to complete
      const resultsArrays = await Promise.all(promises);

      // unravel the results
      const payeesDict = {};
      resultsArrays.forEach(item => {
        item.data.forEach(innerItem => {
          const key = innerItem.payee;
          if (!key) {
            return;
          }
          payeesDict[key] = (payeesDict[key] ?? 0) + innerItem.amount;
        });
      });

      // First, collect all unique IDs from payeesDict
      const payeeIds = Object.keys(payeesDict);

      const results = await aqlQuery(
        q('payees')
          .filter({ id: { $oneof: payeeIds } })
          .select(['id', 'name']),
      );

      // Convert the resulting array to a payee-name-map
      const payeeNames = {};
      results.data.forEach(item => {
        if (item.name && payeesDict[item.id]) {
          payeeNames[item.name] = payeesDict[item.id];
        }
      });
      return payeeNames;
    }

    const incomeData = await fetchIncomeData();
    const categoryData = await fetchCategoryData(categories);

    // convert retrieved data into the proper sankey format
    setData(
      transformToSankeyData(
        categoryData,
        incomeData,
        0,
        'Spent',
        grouped,
        sortBy,
      ),
    );
  };
}

export function createDifferenceSpreadsheet(
  start: string,
  end: string,
  categories: CategoryGroupEntity[],
  conditions: RuleConditionEntity[] = [],
  conditionsOp: 'and' | 'or' = 'and',
  grouped: boolean = true,
  sortBy: 'category' | 'value' | 'alphabetical' = 'category',
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: ReturnType<typeof transformToSankeyData>) => void,
  ) => {
    type BudgetMonthResponse = {
      categoryGroups: BudgetMonthGroup[];
      totalIncome: number;
      fromLastMonth: number;
      forNextMonth: number;
      toBudget: number;
    };

    // Get all months in the range
    const months = monthUtils.rangeInclusive(start, end);

    // Fetch budget data for all months
    const monthlyData = await Promise.all(
      months.map(async month => {
        const response = (await send('api/budget-month', {
          month,
        })) as unknown as BudgetMonthResponse;
        return { month, ...response };
      }),
    );

    // Aggregate budgeted data across all months
    const budgetedData: Record<string, { budgeted: number; name: string }> = {};
    const categoryGroupMap: Record<string, string> = {};
    const incomeData: Record<string, number> = {};
    let totalFromLastMonth = 0;

    for (const data of monthlyData) {
      // Apply filters to category groups
      const filteredCategoryGroups = await filterCategoryGroups(
        data.categoryGroups,
        conditions,
        conditionsOp,
        categories,
      );

      // Aggregate income data
      const incomeGroups = filteredCategoryGroups.filter(
        group => group.is_income === true,
      );
      for (const group of incomeGroups) {
        for (const cat of group.categories) {
          incomeData[cat.name] =
            (incomeData[cat.name] ?? 0) + (cat.received ?? 0);
        }
      }

      // Aggregate expense budgets
      filteredCategoryGroups.forEach(group => {
        if (!group.is_income) {
          group.categories.forEach(cat => {
            if (!budgetedData[cat.id]) {
              budgetedData[cat.id] = {
                budgeted: 0,
                name: cat.name,
              };
              categoryGroupMap[cat.id] = group.name;
            }
            budgetedData[cat.id].budgeted += cat.budgeted || 0;
          });
        }
      });

      // Only count fromLastMonth for the first month
      if (data.month === start && data.fromLastMonth > 0) {
        totalFromLastMonth = data.fromLastMonth;
      }
    }

    // Fetch spent data using transactions
    const { filters } = await send('make-filters-from-conditions', {
      conditions: conditions.filter(cond => !cond.customName),
    });
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    // Get category IDs from aggregated budget data
    const categoryIds = Object.keys(budgetedData);

    async function fetchSpentData() {
      const promises = categoryIds.map(catId => {
        return aqlQuery(
          q('transactions')
            .filter({
              [conditionsOpKey]: filters,
            })
            .filter({
              $and: [
                { date: { $gte: monthUtils.firstDayOfMonth(start) } },
                { date: { $lte: monthUtils.lastDayOfMonth(end) } },
              ],
            })
            .filter({ category: catId })
            .calculate({ $sum: '$amount' }),
        );
      });

      const results = await Promise.all(promises);
      const spentData: Record<string, number> = {};

      categoryIds.forEach((catId, index) => {
        spentData[catId] = Math.abs(results[index].data || 0);
      });

      return spentData;
    }

    const spentData = await fetchSpentData();

    // Calculate difference (budgeted - spent)
    const differenceData: Array<{
      name: string;
      groupName: string;
      difference: number;
      isNegative: boolean;
      isUnderspent: boolean;
    }> = [];

    Object.keys(budgetedData).forEach(catId => {
      const budgeted = budgetedData[catId].budgeted;
      const spent = spentData[catId] || 0;
      const difference = budgeted - spent;

      // Include all categories, even with zero difference
      differenceData.push({
        name: budgetedData[catId].name,
        groupName: categoryGroupMap[catId],
        difference,
        isNegative: difference < 0,
        isUnderspent: difference > 0,
      });
    });

    // Group by category group
    const groupedData: Array<{
      name: string;
      balances: Array<{
        subcategory: string;
        value: number;
        isNegative?: boolean;
        isUnderspent?: boolean;
        actualValue?: number;
      }>;
    }> = [];

    const groupMap = new Map<
      string,
      Array<{
        subcategory: string;
        value: number;
        isNegative?: boolean;
        isUnderspent?: boolean;
        actualValue?: number;
      }>
    >();

    differenceData.forEach(item => {
      if (!groupMap.has(item.groupName)) {
        groupMap.set(item.groupName, []);
      }
      groupMap.get(item.groupName)?.push({
        subcategory: item.name,
        value: Math.abs(item.difference),
        isNegative: item.isNegative,
        isUnderspent: item.isUnderspent,
        actualValue: item.difference, // Store the actual value for display
      });
    });

    groupMap.forEach((balances, groupName) => {
      groupedData.push({
        name: groupName,
        balances,
      });
    });

    // Add "From Last Month" to income data if applicable
    if (totalFromLastMonth > 0) {
      incomeData['From Last Month'] = totalFromLastMonth;
    }

    // convert retrieved data into the proper sankey format
    setData(
      transformToSankeyData(
        groupedData,
        incomeData,
        0,
        'Available Funds',
        grouped,
        sortBy,
      ),
    );
  };
}

function transformToSankeyData(
  categoryData,
  incomeData,
  toBudgetAmount = 0,
  rootNodeName = 'Available Funds',
  grouped = true,
  sortBy: 'category' | 'value' | 'alphabetical' = 'category',
) {
  const data = { nodes: [], links: [] };
  const nodeNames = new Set();
  let groupColorIndex = 0; // Counter for category groups (or categories in flat mode)

  // Sort helper function
  const sortByName = (a, b) => a.name.localeCompare(b.name);

  // Separate "For Next Month" from regular categories - it should always be at the end
  const forNextMonth = categoryData.find(cat => cat.name === 'For Next Month');
  const regularCategories = categoryData.filter(
    cat => cat.name !== 'For Next Month',
  );

  // Sort category data based on sortBy option
  let sortedCategoryData = [...regularCategories];
  if (sortBy === 'value') {
    // Calculate total value for each category group for sorting
    sortedCategoryData = sortedCategoryData
      .map(cat => ({
        ...cat,
        totalValue: cat.balances.reduce(
          (sum, sub) => sum + (sub.value > 0 ? sub.value : 0),
          0,
        ),
      }))
      .sort((a, b) => b.totalValue - a.totalValue);
  } else if (sortBy === 'alphabetical') {
    sortedCategoryData = sortedCategoryData.sort(sortByName);
  }
  // 'category' keeps original order

  // Add "For Next Month" back at the end if it exists
  if (forNextMonth) {
    sortedCategoryData.push(forNextMonth);
  }

  // Add the root node first with toBudget metadata
  data.nodes.push({
    name: rootNodeName,
    toBudget: toBudgetAmount,
    nodeType: 'budget',
  });
  nodeNames.add(rootNodeName);

  // Sort income data based on sortBy option
  let incomeEntries = Object.entries(incomeData);
  if (sortBy === 'value') {
    incomeEntries = incomeEntries.sort(
      (a, b) => (b[1] as number) - (a[1] as number),
    );
  } else if (sortBy === 'alphabetical') {
    incomeEntries = incomeEntries.sort((a, b) => a[0].localeCompare(b[0]));
  }

  // Handle the income sources and link them to the Budget node.
  incomeEntries.forEach(([sourceName, value]) => {
    if (!nodeNames.has(sourceName) && (value as number) > 0) {
      data.nodes.push({
        name: sourceName,
        nodeType: 'income',
      });
      nodeNames.add(sourceName);
      data.links.push({
        source: sourceName,
        target: rootNodeName,
        value,
      });
    }
  });

  // add all category expenses that have valid subcategories and a balance
  for (const mainCategory of sortedCategoryData) {
    if (mainCategory.balances.length > 0) {
      let mainCategorySum = 0;
      for (const subCategory of mainCategory.balances) {
        if (!nodeNames.has(subCategory.subcategory) && subCategory.value > 0) {
          mainCategorySum += subCategory.value;
        }
      }
      if (mainCategorySum === 0) {
        continue;
      }

      if (grouped) {
        // Grouped mode: category group and its children share the same color
        const currentGroupColor = groupColorIndex++;

        if (!nodeNames.has(mainCategory.name)) {
          data.nodes.push({
            name: mainCategory.name,
            nodeType: 'expense',
            colorIndex: currentGroupColor,
          });
          nodeNames.add(mainCategory.name);

          data.links.push({
            source: rootNodeName,
            target: mainCategory.name,
            value: mainCategorySum,
          });
        }

        // Sort subcategories based on sortBy option
        let sortedBalances = [...mainCategory.balances];
        if (sortBy === 'value') {
          sortedBalances = sortedBalances.sort((a, b) => b.value - a.value);
        } else if (sortBy === 'alphabetical') {
          sortedBalances = sortedBalances.sort((a, b) =>
            a.subcategory.localeCompare(b.subcategory),
          );
        }

        // Subcategories inherit the parent group's color
        for (const subCategory of sortedBalances) {
          if (
            !nodeNames.has(subCategory.subcategory) &&
            subCategory.value > 0
          ) {
            data.nodes.push({
              name: subCategory.subcategory,
              nodeType: 'expense',
              isNegative: subCategory.isNegative,
              isUnderspent: subCategory.isUnderspent,
              colorIndex: currentGroupColor, // Same color as parent group
            });
            nodeNames.add(subCategory.subcategory);

            data.links.push({
              source: mainCategory.name,
              target: subCategory.subcategory,
              value: subCategory.value,
              isNegative: subCategory.isNegative,
              isUnderspent: subCategory.isUnderspent,
            });
          }
        }
      } else {
        // Flat mode: collect all subcategories first, then sort and add
        const allSubcategories = [];
        let forNextMonthSubcat = null;
        for (const cat of sortedCategoryData) {
          for (const subCategory of cat.balances) {
            if (
              !nodeNames.has(subCategory.subcategory) &&
              subCategory.value > 0
            ) {
              // Keep "For Next Month" separate - it should always be at the end
              if (subCategory.subcategory === 'For Next Month') {
                forNextMonthSubcat = subCategory;
              } else {
                allSubcategories.push(subCategory);
              }
            }
          }
        }

        // Sort all subcategories based on sortBy option
        if (sortBy === 'value') {
          allSubcategories.sort((a, b) => b.value - a.value);
        } else if (sortBy === 'alphabetical') {
          allSubcategories.sort((a, b) =>
            a.subcategory.localeCompare(b.subcategory),
          );
        }

        // Add "For Next Month" at the end if it exists
        if (forNextMonthSubcat) {
          allSubcategories.push(forNextMonthSubcat);
        }

        // Add sorted subcategories
        for (const subCategory of allSubcategories) {
          if (!nodeNames.has(subCategory.subcategory)) {
            data.nodes.push({
              name: subCategory.subcategory,
              nodeType: 'expense',
              isNegative: subCategory.isNegative,
              isUnderspent: subCategory.isUnderspent,
              colorIndex: groupColorIndex++,
            });
            nodeNames.add(subCategory.subcategory);

            data.links.push({
              source: rootNodeName,
              target: subCategory.subcategory,
              value: subCategory.value,
              isNegative: subCategory.isNegative,
              isUnderspent: subCategory.isUnderspent,
            });
          }
        }

        // Skip the rest of the loop since we handled all flat categories
        break;
      }
    }
  }

  // Map source and target in links to the index of the node
  data.links.forEach(link => {
    link.source = data.nodes.findIndex(node => node.name === link.source);
    link.target = data.nodes.findIndex(node => node.name === link.target);
  });

  return data;
}
