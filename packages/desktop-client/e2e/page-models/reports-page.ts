import { type Locator, type Page } from '@playwright/test';

import { CustomReportPage } from './custom-report-page';
import { SankeyPage } from './sankey-page';

export class ReportsPage {
  readonly page: Page;
  readonly pageContent: Locator;

  constructor(page: Page) {
    this.page = page;
    this.pageContent = page.getByTestId('reports-page');
  }

  async waitToLoad() {
    return this.pageContent.getByRole('button', { name: /^Net/ }).waitFor();
  }

  async goToNetWorthPage() {
    await this.pageContent.getByRole('button', { name: /^Net/ }).click();
    return new ReportsPage(this.page);
  }

  async goToCashFlowPage() {
    await this.pageContent.getByRole('button', { name: /^Cash/ }).click();
    return new ReportsPage(this.page);
  }

  async goToCustomReportPage() {
    await this.pageContent
      .getByRole('button', { name: 'Add new widget' })
      .click();
    await this.page.getByRole('button', { name: 'New custom report' }).click();
    return new CustomReportPage(this.page);
  }

  async addSankeyWidget() {
    const addWidgetButton = this.pageContent.getByRole('button', {
      name: 'Add new widget',
    });
    await addWidgetButton.click();
    // Wait for the menu to appear and click Sankey card
    const sankeyMenuItem = this.page.getByRole('button', {
      name: 'Sankey card',
    });
    await sankeyMenuItem.waitFor({ state: 'visible' });
    await sankeyMenuItem.click();
    // Widget is added at the bottom - scroll to bottom of page
    await this.page.evaluate(() =>
      window.scrollTo(0, document.body.scrollHeight),
    );
    // Wait for widget to appear
    await this.pageContent
      .getByRole('button', { name: /^Sankey/ })
      .waitFor({ state: 'visible' });
  }

  async goToSankeyPage() {
    // First scroll to bottom to check if Sankey widget exists
    await this.page.evaluate(() =>
      window.scrollTo(0, document.body.scrollHeight),
    );

    const sankeyButton = this.pageContent.getByRole('button', {
      name: /^Sankey/,
    });

    // If not visible, add it
    if (!(await sankeyButton.isVisible({ timeout: 1000 }).catch(() => false))) {
      await this.addSankeyWidget();
    }

    await sankeyButton.click();
    return new SankeyPage(this.page);
  }

  async getAvailableReportList() {
    return this.pageContent
      .getByRole('button')
      .getByRole('heading')
      .allTextContents();
  }
}
