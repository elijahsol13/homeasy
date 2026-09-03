import type { DatabaseSync } from 'node:sqlite';
import type { Api } from 'grammy';
import { createDatabase } from './database/db';
import { UsersRepository } from './database/repositories/users.repo';
import { PropertiesRepository } from './database/repositories/properties.repo';
import { FiltersRepository } from './database/repositories/filters.repo';
import { FavoritesRepository } from './database/repositories/favorites.repo';
import { NotifierService } from './services/notifier';
import { MatcherService } from './modules/matcher/matcher';
import { IngestionService } from './modules/parser/ingestor';

export interface AppContainer {
  db: DatabaseSync;
  usersRepo: UsersRepository;
  propertiesRepo: PropertiesRepository;
  filtersRepo: FiltersRepository;
  favoritesRepo: FavoritesRepository;
  notifierService: NotifierService;
  matcherService: MatcherService;
  ingestionService: IngestionService;
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
  const notifierService = new NotifierService(options?.api);
  const matcherService = new MatcherService(filtersRepo, usersRepo, propertiesRepo, notifierService);
  const ingestionService = new IngestionService(propertiesRepo, matcherService);

  return {
    db,
    usersRepo,
    propertiesRepo,
    filtersRepo,
    favoritesRepo,
    notifierService,
    matcherService,
    ingestionService,
  };
}

