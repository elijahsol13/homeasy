import type { DatabaseSync } from 'node:sqlite';
import type { Api } from 'grammy';
import { createDatabase } from './database/db';
import { UsersRepository } from './database/repositories/users.repo';
import { PropertiesRepository } from './database/repositories/properties.repo';
import { FiltersRepository } from './database/repositories/filters.repo';
import { FavoritesRepository } from './database/repositories/favorites.repo';
import { MetricsRepository } from './database/repositories/metrics.repo';
import { AnalyticsRepository } from './database/repositories/analytics.repo';
import { NotifierService } from './services/notifier';
import { AlertService } from './services/alert.service';
import { MatcherService } from './modules/matcher/matcher';
import { IngestionService } from './modules/parser/ingestor';
import { RemoteBrowserService } from './services/remote-browser.service';
import { NLSearchService } from './services/nl-search.service';
import { LinkVerifierService } from './services/link-verifier.service';

export interface AppContainer {
  db: DatabaseSync;
  usersRepo: UsersRepository;
  propertiesRepo: PropertiesRepository;
  filtersRepo: FiltersRepository;
  favoritesRepo: FavoritesRepository;
  metricsRepo: MetricsRepository;
  analyticsRepo: AnalyticsRepository;
  notifierService: NotifierService;
  matcherService: MatcherService;
  ingestionService: IngestionService;
  remoteBrowserService: RemoteBrowserService;
  alertService: AlertService;
  nlSearchService: NLSearchService;
  linkVerifierService: LinkVerifierService;
}

export interface CreateContainerOptions {
  dbPath?: string;
  api?: Api;
  db?: DatabaseSync;
}

/**
 * Composition root: instantiates and wires all dependencies hierarchically.
 */
export function createContainer(options?: CreateContainerOptions): AppContainer {
  const db = options?.db ?? createDatabase(options?.dbPath);
  const usersRepo = new UsersRepository(db);
  const propertiesRepo = new PropertiesRepository(db);
  const filtersRepo = new FiltersRepository(db);
  const favoritesRepo = new FavoritesRepository(db);
  const metricsRepo = new MetricsRepository(db);
  const analyticsRepo = new AnalyticsRepository(db);
  const notifierService = new NotifierService(options?.api);
  const alertService = new AlertService(options?.api);
  const matcherService = new MatcherService(filtersRepo, usersRepo, propertiesRepo, notifierService);
  const ingestionService = new IngestionService(propertiesRepo, matcherService, alertService);
  const nlSearchService = new NLSearchService(propertiesRepo, analyticsRepo);
  const linkVerifierService = new LinkVerifierService(propertiesRepo, alertService);

  const container = {
    db,
    usersRepo,
    propertiesRepo,
    filtersRepo,
    favoritesRepo,
    metricsRepo,
    analyticsRepo,
    notifierService,
    matcherService,
    ingestionService,
    alertService,
    nlSearchService,
    linkVerifierService,
  } as AppContainer;

  container.remoteBrowserService = new RemoteBrowserService(container);

  return container;
}


