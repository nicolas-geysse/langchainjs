import * as uuid from "uuid";

import { AstraDB } from "@datastax/astra-db-ts";
import { Collection } from "@datastax/astra-db-ts/dist/collections";
import { CreateCollectionOptions } from "@datastax/astra-db-ts/dist/collections/options.js";

import { Document } from "@langchain/core/documents";
import { Embeddings } from "@langchain/core/embeddings";
import { maximalMarginalRelevance } from "@langchain/core/utils/math";
import { MaxMarginalRelevanceSearchOptions, VectorStore } from "@langchain/core/vectorstores";

export type CollectionFilter = Record<string, unknown>;

export interface AstraLibArgs {
  token: string;
  endpoint: string;
  collection: string;
  namespace?: string;
  idKey?: string;
  contentKey?: string;
  collectionOptions?: CreateCollectionOptions;
}

export class AstraDBVectorStore extends VectorStore {
  declare FilterType: CollectionFilter;

  private astraDBClient: AstraDB;

  private collectionName: string;

  private collection: Collection | undefined;

  private collectionOptions: CreateCollectionOptions | undefined;

  private readonly idKey: string;

  private readonly contentKey: string; // if undefined the entirety of the content aside from the id and embedding will be stored as content

  _vectorstoreType(): string {
    return "astradb";
  }

  constructor(embeddings: Embeddings, args: AstraLibArgs) {
    super(embeddings, args);

    this.astraDBClient = new AstraDB(
      args.token, args.endpoint
    );
    this.collectionName = args.collection;
    this.collectionOptions = args.collectionOptions;
    this.idKey = args.idKey ?? "_id";
    this.contentKey = args.contentKey ?? "content";
  }

  async initalize(): Promise<void> {
    try {
      await this.astraDBClient.createCollection(this.collectionName, this.collectionOptions);
    } catch (error) {
      console.debug(`Collection already exists, connecting to ${this.collectionName}`);
    }
    this.collection = await this.astraDBClient.collection(this.collectionName);
    console.debug("Connected to Astra DB collection");
  }

  /**
   * Create a new collection in your Astra DB vector database.
   * You must still use connect() to connect to the collection.
   *
   * @param collection your new colletion's name
   * @param options: CreateCollectionOptions used to set the number of vector dimensions and similarity metric
   * @returns Promise that resolves if the creation did not throw an error.
   */
  async create(
    collection: string,
    options: CreateCollectionOptions,
  ): Promise<void> {
    await this.astraDBClient.createCollection(collection, options);
    console.debug("Created Astra DB collection");
  }

  /**
   * Connect to an existing collection in your Astra DB vector database.
   * You must call this before adding, deleting, or querying.
   *
   * @param collection your existing colletion's name
   * @returns Promise that resolves if the connection did not throw an error.
   */
  async connect(collection: string): Promise<void> {
    this.collection = await this.astraDBClient.collection(collection);
    console.debug("Connected to Astra DB collection");
  }

  async addDocuments(documents: Document[]) {
    if (!this.collection) {
      throw new Error("Must connect to a collection before adding vectors");
    }

    return this.addVectors(
      await this.embeddings.embedDocuments(documents.map((d) => d.pageContent)),
      documents
    );
  }

  async addVectors(vectors: number[][], documents: Document[], options?: string[]): Promise<void> {
    if (!this.collection) {
      throw new Error("Must connect to a collection before adding vectors");
    }

    const docs = vectors.map((embedding, idx) => ({
      [this.idKey]: options?.[idx] ?? uuid.v4(),
      [this.contentKey]: documents[idx].pageContent,
      $vector: embedding,
      ...documents[idx].metadata,
    }));

    await this.collection.insertMany(docs);
  }

  async similaritySearchVectorWithScore(
    query: number[],
    k: number,
    filter?: CollectionFilter
  ): Promise<[Document, number][]> {
    if (!this.collection) {
      throw new Error("Must connect to a collection before adding vectors");
    }
    
    const cursor = await this.collection.find(
      filter ?? {},
      { 
        sort: { $vector: query },
        limit: k,
        includeSimilarity: true,
      }
    );

    const results: [Document, number][] = [];

    await cursor.forEach(async (row: Record<string, unknown>) => {
      
      const {
        $similarity: similarity, 
        $vector: _vector, 
        [this.idKey]: _id, 
        [this.contentKey]: content, 
        ...metadata
      } = row;

      const doc = new Document({
        pageContent: content as string,
        metadata,
      });

      results.push([doc, similarity as number]);
    });

    return results;
  }


  /**
     * Return documents selected using the maximal marginal relevance.
     * Maximal marginal relevance optimizes for similarity to the query AND diversity
     * among selected documents.
     *
     * @param {string} query - Text to look up documents similar to.
     * @param {number} options.k - Number of documents to return.
     * @param {number} options.fetchK - Number of documents to fetch before passing to the MMR algorithm.
     * @param {number} options.lambda - Number between 0 and 1 that determines the degree of diversity among the results,
     *                 where 0 corresponds to maximum diversity and 1 to minimum diversity.
     * @param {CollectionFilter} options.filter - Optional filter
     * @param _callbacks
     *
     * @returns {Promise<Document[]>} - List of documents selected by maximal marginal relevance.
     */
  async maxMarginalRelevanceSearch(
    query: string,
    options: MaxMarginalRelevanceSearchOptions<this["FilterType"]>,
  ): Promise<Document[]> {
    if (!this.collection) {
      throw new Error("Must connect to a collection before adding vectors");
    }

    const queryEmbedding = await this.embeddings.embedQuery(query);
    
    const cursor = await this.collection.find(
      options.filter ?? {},
      { 
        sort: { $vector: queryEmbedding },
        limit: options.k,
        includeSimilarity: true,
      }
    );

    const results = await cursor.toArray() ?? [];
    const embeddingList: number[][] = results.map((row) => row.$vector as number[]);

    const mmrIndexes = maximalMarginalRelevance(
      queryEmbedding,
      embeddingList,
      options.lambda,
      options.k
    );

    const topMmrMatches = mmrIndexes.map((idx) => results[idx]);

    const docs: Document[] = [];
    topMmrMatches.forEach((match) => {
      const {
        $similarity: _similarity, 
        $vector: _vector, 
        [this.idKey]: id, 
        [this.contentKey]: content, 
        ...metadata
      } = match;

      const doc: Document = {
        pageContent: content as string,
        metadata,
      };

      docs.push(doc);
    });

    return docs;
  }

  static async fromTexts(
    texts: string[], 
    metadatas: object[] | object,
    embeddings: Embeddings,
    dbConfig: AstraLibArgs
  ): Promise<AstraDBVectorStore> {
    const docs: Document[] = [];
    for (let i = 0; i < texts.length; i += 1) {
      const metadata = Array.isArray(metadatas) ? metadatas[i] : metadatas;
      const doc = new Document({
        pageContent: texts[i],
        metadata,
      });
      docs.push(doc);
    }
    return AstraDBVectorStore.fromDocuments(docs, embeddings, dbConfig);
  }

  static async fromDocuments(
    docs: Document[], 
    embeddings: Embeddings, 
    dbConfig: AstraLibArgs
  ): Promise<AstraDBVectorStore> {
    const instance = new this(embeddings, dbConfig);
    await instance.initalize();

    await instance.addDocuments(docs);
    return instance;
  }
}