import { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PaginatedResponse } from '../utils/helpscout-client.js';
import { createMcpToolError } from '../utils/mcp-errors.js';
import { HelpScoutAPIConstraints, ToolCallContext } from '../utils/api-constraints.js';
import { Injectable, ServiceContainer } from '../utils/service-container.js';
import { z } from 'zod';

/**
 * Constants for tool operations
 */
const TOOL_CONSTANTS = {
  // API pagination defaults
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 100,
  MAX_THREAD_SIZE: 200,
  DEFAULT_THREAD_SIZE: 200,
  
  // Search limits
  MAX_SEARCH_TERMS: 10,
  DEFAULT_TIMEFRAME_DAYS: 60,
  DEFAULT_LIMIT_PER_STATUS: 25,
  
  // Sort configuration
  DEFAULT_SORT_FIELD: 'createdAt',
  DEFAULT_SORT_ORDER: 'desc',
  
  // Cache and performance
  MAX_CONVERSATION_ID_LENGTH: 20,
  
  // Search locations
  SEARCH_LOCATIONS: {
    BODY: 'body',
    SUBJECT: 'subject', 
    BOTH: 'both'
  } as const,
  
  // Conversation statuses
  STATUSES: {
    ACTIVE: 'active',
    PENDING: 'pending',
    CLOSED: 'closed',
    SPAM: 'spam'
  } as const
} as const;
import {
  Inbox,
  Conversation,
  Thread,
  ServerTime,
  SearchInboxesInputSchema,
  SearchConversationsInputSchema,
  GetThreadsInputSchema,
  GetConversationSummaryInputSchema,
  AdvancedConversationSearchInputSchema,
  MultiStatusConversationSearchInputSchema,
  CreateConversationInputSchema,
  ReplyToConversationInputSchema,
  DeleteConversationInputSchema,
  GetCurrentUserInputSchema,
} from '../schema/types.js';

export class ToolHandler extends Injectable {
  private callHistory: string[] = [];
  private currentUserQuery?: string;

  constructor(container?: ServiceContainer) {
    super(container);
  }

  /**
   * Set the current user query for context-aware validation
   */
  setUserContext(userQuery: string): void {
    this.currentUserQuery = userQuery;
  }

  async listTools(): Promise<Tool[]> {
    return [
      {
        name: 'getCurrentUser',
        description: 'Gets the user profile of the currently authenticated user (the agent). CRITICAL: You MUST call this tool to get the `userId` before you can reply to a conversation.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'getConversationSummary',
        description: 'Get conversation summary, including the primary customer\'s ID. CRITICAL: You MUST call this tool to get the `customerId` before you can reply to a conversation.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to get summary for',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'replyToConversation',
        description: 'Adds a reply to an existing conversation using the official /reply endpoint. WORKFLOW: 1. Call `getCurrentUser()` to get the `userId`. 2. Call `getConversationSummary()` to get the `customerId`. 3. Call this tool with all required IDs.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The ID of the conversation to reply to.',
            },
            text: {
              type: 'string',
              description: 'The content of the reply message.',
            },
            userId: {
              type: 'number',
              description: 'The ID of the user sending the reply. Get this from `getCurrentUser()`.',
            },
            customerId: {
              type: 'number',
              description: 'The ID of the customer being replied to. Get this from `getConversationSummary()`.',
            },
          },
          required: ['conversationId', 'text', 'userId', 'customerId'],
        },
      },
      {
        name: 'createConversation',
        description: 'Creates a new outbound conversation TO a customer. WORKFLOW: 1. Call `getCurrentUser()` to get the agent\'s `userId`. 2. Call this tool, placing the `userId` inside the `user` field of the initial `reply` thread.',
        inputSchema: {
          type: 'object',
          properties: {
            mailboxId: { type: 'number', description: 'ID of the inbox for the conversation.' },
            subject: { type: 'string', description: 'The subject line.' },
            customer: {
              type: 'object',
              properties: {
                id: { type: 'number', description: 'Existing customer ID.' },
                email: { type: 'string', description: 'Customer email. A new customer will be created if not found.' },
                firstName: { type: 'string' },
                lastName: { type: 'string' },
              },
              description: 'The customer the conversation is being sent TO.',
            },
            type: { type: 'string', enum: ['email', 'chat', 'phone'], description: "The type of conversation, almost always 'email'." },
            status: { type: 'string', enum: ['active', 'pending', 'closed'], description: 'The initial status.' },
            threads: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { enum: ['reply'], description: "MUST be 'reply' to start an outbound conversation." },
                  text: { type: 'string', description: 'Content of the message.' },
                  user: { type: 'number', description: "The agent's ID from `getCurrentUser()`. This is REQUIRED for a reply." },
                },
                required: ['type', 'text', 'user'],
              },
              description: 'The initial message. Must be a single thread of type `reply` containing the agent\'s user ID.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'A list of tags to add to the conversation.',
            },
            assignTo: {
              type: 'number',
              description: 'ID of the user to assign the conversation to. Use null for unassigned.',
            },
          },
          required: ['mailboxId', 'subject', 'customer', 'type', 'status', 'threads'],
        },
      },
      {
        name: 'deleteConversation',
        description: 'Permanently deletes a conversation. This action cannot be undone. Use with extreme caution.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The ID of the conversation to permanently delete.',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'searchInboxes',
        description: 'STEP 1: Always use this FIRST when searching conversations. Lists all available inboxes or filters by name. CRITICAL: When a user mentions an inbox by name (e.g., "support inbox", "sales mailbox"), you MUST call this tool first to get the inbox ID before searching conversations.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to match inbox names. Use empty string "" to list ALL inboxes. This is case-insensitive substring matching.',
            },
            limit: {
              type: 'number',
              description: `Maximum number of results (1-${TOOL_CONSTANTS.MAX_PAGE_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'searchConversations',
        description: 'STEP 2: Search conversations after obtaining inbox ID. WARNING: Always get inboxId from searchInboxes first if user mentions an inbox name. IMPORTANT: Specify status (active/pending/closed/spam) for better results, or use comprehensiveConversationSearch for multi-status searching.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'HelpScout query syntax for content search. Examples: (body:"keyword"), (subject:"text"), (email:"user@domain.com"), (tag:"tagname"), (customerIds:123), complex: (body:"urgent" OR subject:"support")',
            },
            inboxId: {
              type: 'string',
              description: 'Filter by inbox ID. REQUIRED when user mentions a specific inbox. Get this ID by calling searchInboxes first!',
            },
            tag: {
              type: 'string',
              description: 'Filter by tag name',
            },
            status: {
              type: 'string',
              enum: [TOOL_CONSTANTS.STATUSES.ACTIVE, TOOL_CONSTANTS.STATUSES.PENDING, TOOL_CONSTANTS.STATUSES.CLOSED, TOOL_CONSTANTS.STATUSES.SPAM],
              description: 'Filter by conversation status. CRITICAL: HelpScout often returns no results without this parameter. For comprehensive search across all statuses, use comprehensiveConversationSearch instead.',
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created after this timestamp (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created before this timestamp (ISO8601)',
            },
            limit: {
              type: 'number',
              description: `Maximum number of results (1-${TOOL_CONSTANTS.MAX_PAGE_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
            sort: {
              type: 'string',
              enum: ['createdAt', 'updatedAt', 'number'],
              default: TOOL_CONSTANTS.DEFAULT_SORT_FIELD,
              description: 'Sort field',
            },
            order: {
              type: 'string',
              enum: ['asc', 'desc'],
              default: TOOL_CONSTANTS.DEFAULT_SORT_ORDER,
              description: 'Sort order',
            },
            fields: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific fields to return (for partial responses)',
            },
          },
        },
      },
      {
        name: 'getThreads',
        description: 'Get all thread messages for a conversation',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to get threads for',
            },
            limit: {
              type: 'number',
              description: `Maximum number of threads (1-${TOOL_CONSTANTS.MAX_THREAD_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_THREAD_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_THREAD_SIZE,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'getServerTime',
        description: 'Get current server time for time-relative searches',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'listAllInboxes',
        description: 'QUICK HELPER: Lists ALL available inboxes with their IDs. This is equivalent to searchInboxes with empty query but more explicit. Use this when you need to see all inboxes or when starting any inbox-specific search.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of results (1-100)',
              minimum: 1,
              maximum: 100,
              default: 100,
            },
          },
        },
      },
      {
        name: 'advancedConversationSearch',
        description: 'Advanced conversation search with complex boolean queries and customer organization support',
        inputSchema: {
          type: 'object',
          properties: {
            contentTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Search terms to find in conversation body/content (will be OR combined)',
            },
            subjectTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Search terms to find in conversation subject (will be OR combined)',
            },
            customerEmail: {
              type: 'string',
              description: 'Exact customer email to search for',
            },
            emailDomain: {
              type: 'string',
              description: 'Email domain to search for (e.g., "company.com" to find all @company.com emails)',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tag names to search for (will be OR combined)',
            },
            inboxId: {
              type: 'string',
              description: 'Filter by inbox ID',
            },
            status: {
              type: 'string',
              enum: [TOOL_CONSTANTS.STATUSES.ACTIVE, TOOL_CONSTANTS.STATUSES.PENDING, TOOL_CONSTANTS.STATUSES.CLOSED, TOOL_CONSTANTS.STATUSES.SPAM],
              description: 'Filter by conversation status',
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created after this timestamp (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created before this timestamp (ISO8601)',
            },
            limit: {
              type: 'number',
              description: `Maximum number of results (1-${TOOL_CONSTANTS.MAX_PAGE_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
          },
        },
      },
      {
        name: 'comprehensiveConversationSearch',
        description: 'RECOMMENDED FOR GENERAL SEARCHES: Searches across multiple statuses simultaneously, solving the common issue where searches return no results. WORKFLOW: 1) If user mentions an inbox name, call searchInboxes FIRST to get the ID. 2) Then use this tool with the inbox ID. This tool automatically searches active, pending, and closed conversations.',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Search terms to find in conversations (will be combined with OR logic)',
              minItems: 1,
            },
            inboxId: {
              type: 'string',
              description: 'Filter by specific inbox ID. IMPORTANT: If user mentions an inbox by name, you MUST call searchInboxes first to get this ID!',
            },
            statuses: {
              type: 'array',
              items: { enum: ['active', 'pending', 'closed', 'spam'] },
              description: 'Conversation statuses to search (defaults to active, pending, closed)',
              default: ['active', 'pending', 'closed'],
            },
            searchIn: {
              type: 'array',
              items: { enum: ['body', 'subject', 'both'] },
              description: 'Where to search for terms (defaults to both body and subject)',
              default: ['both'],
            },
            timeframeDays: {
              type: 'number',
              description: `Number of days back to search (defaults to ${TOOL_CONSTANTS.DEFAULT_TIMEFRAME_DAYS})`,
              minimum: 1,
              maximum: 365,
              default: TOOL_CONSTANTS.DEFAULT_TIMEFRAME_DAYS,
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Override timeframeDays with specific start date (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'End date for search range (ISO8601)',
            },
            limitPerStatus: {
              type: 'number',
              description: `Maximum results per status (defaults to ${TOOL_CONSTANTS.DEFAULT_LIMIT_PER_STATUS})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_LIMIT_PER_STATUS,
            },
            includeVariations: {
              type: 'boolean',
              description: 'Include common variations of search terms',
              default: true,
            },
          },
          required: ['searchTerms'],
        },
      },
    ];
  }

  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();

    const { logger } = this.services.resolve(['logger']);
    
    logger.info('Tool call started', {
      requestId,
      toolName: request.params.name,
      arguments: request.params.arguments,
    });

    // REVERSE LOGIC VALIDATION: Check API constraints before making the call
    const validationContext: ToolCallContext = {
      toolName: request.params.name,
      arguments: request.params.arguments || {},
      userQuery: this.currentUserQuery,
      previousCalls: [...this.callHistory]
    };

    const validation = HelpScoutAPIConstraints.validateToolCall(validationContext);
    
    if (!validation.isValid) {
      const errorDetails = {
        errors: validation.errors,
        suggestions: validation.suggestions,
        requiredPrerequisites: validation.requiredPrerequisites
      };
      
      logger.warn('Tool call validation failed', {
        requestId,
        toolName: request.params.name,
        validation: errorDetails
      });
      
      // Return helpful error with API constraint guidance
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'API Constraint Validation Failed',
            details: errorDetails,
            helpScoutAPIRequirements: {
              message: 'This call violates Help Scout API constraints',
              requiredActions: validation.requiredPrerequisites || [],
              suggestions: validation.suggestions
            }
          }, null, 2)
        }]
      };
    }

    try {
      let result: CallToolResult;

      switch (request.params.name) {
        case 'searchInboxes':
          result = await this.searchInboxes(request.params.arguments || {});
          break;
        case 'searchConversations':
          result = await this.searchConversations(request.params.arguments || {});
          break;
        case 'getConversationSummary':
          result = await this.getConversationSummary(request.params.arguments || {});
          break;
        case 'getThreads':
          result = await this.getThreads(request.params.arguments || {});
          break;
        case 'getServerTime':
          result = await this.getServerTime();
          break;
        case 'listAllInboxes':
          result = await this.listAllInboxes(request.params.arguments || {});
          break;
        case 'advancedConversationSearch':
          result = await this.advancedConversationSearch(request.params.arguments || {});
          break;
        case 'comprehensiveConversationSearch':
          result = await this.comprehensiveConversationSearch(request.params.arguments || {});
          break;
        case 'getCurrentUser':
          result = await this.getCurrentUser();
          break;
        case 'replyToConversation':
          result = await this.replyToConversation(request.params.arguments || {});
          break;
        case 'createConversation':
          result = await this.createConversation(request.params.arguments || {});
          break;
        case 'deleteConversation':
          result = await this.deleteConversation(request.params.arguments || {});
          break;

        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const duration = Date.now() - startTime;
      // Add to call history for future validation
      this.callHistory.push(request.params.name);
      
      // Enhance result with API constraint guidance
      const guidance = HelpScoutAPIConstraints.generateToolGuidance(
        request.params.name, 
        JSON.parse((result.content[0] as any).text), 
        validationContext
      );
      
      if (guidance.length > 0) {
        const originalContent = JSON.parse((result.content[0] as any).text);
        originalContent.apiGuidance = guidance;
        result.content[0] = {
          type: 'text',
          text: JSON.stringify(originalContent, null, 2)
        };
      }

      logger.info('Tool call completed', {
        requestId,
        toolName: request.params.name,
        duration,
        validationPassed: true,
        guidanceProvided: guidance.length > 0
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      return createMcpToolError(error, {
        toolName: request.params.name,
        requestId,
        duration,
      });
    }
  }

  private async searchInboxes(args: unknown): Promise<CallToolResult> {
    const input = SearchInboxesInputSchema.parse(args);
    const { helpScoutClient } = this.services.resolve(['helpScoutClient']);
    
    const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
      page: 1,
      size: input.limit,
    });

    const inboxes = response._embedded?.mailboxes || [];
    const filteredInboxes = inboxes.filter(inbox => 
      inbox.name.toLowerCase().includes(input.query.toLowerCase())
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: filteredInboxes.map(inbox => ({
              id: inbox.id,
              name: inbox.name,
              email: inbox.email,
              createdAt: inbox.createdAt,
              updatedAt: inbox.updatedAt,
            })),
            query: input.query,
            totalFound: filteredInboxes.length,
            totalAvailable: inboxes.length,
            usage: filteredInboxes.length > 0 ? 
              'NEXT STEP: Use the "id" field from these results in your conversation search tools (comprehensiveConversationSearch or searchConversations)' : 
              'No inboxes matched your query. Try a different search term or use empty string "" to list all inboxes.',
            example: filteredInboxes.length > 0 ? 
              `comprehensiveConversationSearch({ searchTerms: ["your search"], inboxId: "${filteredInboxes[0].id}" })` : 
              null,
          }, null, 2),
        },
      ],
    };
  }

  private async getCurrentUser(): Promise<CallToolResult> {
    const { helpScoutClient } = this.services.resolve(['helpScoutClient']);
    
    // The /v2/users/me endpoint returns the authenticated user's details
    const user = await helpScoutClient.get<any>('/users/me');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role,
          usage: "SUCCESS: You now have the user ID. Use this 'id' in the 'userId' field when calling replyToConversation.",
        }, null, 2),
      }],
    };
  }

  private async replyToConversation(args: unknown): Promise<CallToolResult> {
    const input = ReplyToConversationInputSchema.parse(args);
    const { helpScoutClient, logger } = this.services.resolve(['helpScoutClient', 'logger']);

    // --- STEP 1: Post the reply. This part is working, which is great! ---
    const replyPayload = {
      text: input.text,
      user: input.userId,
      customer: { id: input.customerId },
    };

    await helpScoutClient.post(
      `/conversations/${input.conversationId}/reply`,
      replyPayload
    );
    logger.info(`Reply sent to conversation ${input.conversationId}.`);

    // --- STEP 2: Update the status with its own, separate PATCH request. ---
    const statusPatchPayload = {
      op: 'replace',
      path: '/status',
      value: 'pending',
    };
    logger.info('Attempting to patch conversation status...', { 
        conversationId: input.conversationId, 
        payload: statusPatchPayload 
    });
    await helpScoutClient.patch(`/conversations/${input.conversationId}`, statusPatchPayload);
    logger.info('Status patch request sent.');


    // --- STEP 3: Update the assignment with a second, separate PATCH request. ---
    const assignmentPatchPayload = {
      op: 'replace',
      path: '/assignTo',
      value: input.userId,
    };
    logger.info('Attempting to patch conversation assignment...', { 
        conversationId: input.conversationId, 
        payload: assignmentPatchPayload 
    });
    await helpScoutClient.patch(`/conversations/${input.conversationId}`, assignmentPatchPayload);
    logger.info('Assignment patch request sent.');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Successfully sent reply and initiated updates for conversation ${input.conversationId}.`,
          finalStatus: 'pending',
          assignedTo: input.userId,
        }, null, 2),
      }],
    };
  }

  private async getCustomerIdByEmail(email: string): Promise<number> {
    const { helpScoutClient, logger } = this.services.resolve(['helpScoutClient', 'logger']);
    
    logger.info(`Searching for customer ID by email: ${email}`);
    
    // The response is a paginated list, so we need to handle the _embedded structure
    type CustomerSearchResponse = {
      _embedded: {
        customers: { id: number }[];
      };
    };

    const response = await helpScoutClient.get<CustomerSearchResponse>(`/customers?email=${encodeURIComponent(email)}`);
    
    const customer = response._embedded?.customers?.[0];
    
    if (!customer?.id) {
      throw new Error(`Could not find a customer with the email: ${email}`);
    }
    
    logger.info(`Found customer ID: ${customer.id}`);
    return customer.id;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async createConversation(args: unknown): Promise<CallToolResult> {
    const input = CreateConversationInputSchema.parse(args);
    const { helpScoutClient, logger } = this.services.resolve(['helpScoutClient', 'logger']);

    const agentReplyThread = input.threads[0];
    if (!agentReplyThread || agentReplyThread.type !== 'reply' || !agentReplyThread.user) {
      throw new Error("createConversation requires a single thread of type 'reply' with a user ID.");
    }
    const agentUserId = agentReplyThread.user;
    const agentMessageText = agentReplyThread.text;

    logger.info('Starting Help Scout Customer-First outbound process...');

    // --- Step 1: Create the conversation container ---
    const creationPayload = {
      mailboxId: input.mailboxId,
      subject: input.subject,
      customer: input.customer,
      type: input.type,
      status: 'pending',
      threads: [{
        type: 'customer',
        text: `Conversation initiated by agent.`,
        customer: { email: input.customer.email }
      }],
      tags: input.tags,
    };

    const creationResponse = await helpScoutClient.post('/conversations', creationPayload as Record<string, unknown>);
    const locationHeader = creationResponse.headers.location;
    if (!locationHeader) throw new Error('Failed to create conversation: No Location header in response.');
    
    const conversationId = locationHeader.split('/').pop();
    if (!conversationId) throw new Error('Failed to parse new conversation ID from Location header.');
    
    logger.info(`Step 1 complete. Created conversation container: ${conversationId}`);

    // --- Step 2: Find the customer ID directly via their email ---
    if (!input.customer.email) {
      throw new Error("Customer email is required to find the customer ID for the reply.");
    }
    const customerId = await this.getCustomerIdByEmail(input.customer.email);
    logger.info(`Step 2 complete. Found customer ID: ${customerId}`);

    // --- Step 3: Post the actual agent reply with all correct IDs ---
    const replyPayload = {
      text: agentMessageText,
      user: agentUserId,
      customer: { id: customerId },
    };

    await helpScoutClient.post(`/conversations/${conversationId}/reply`, replyPayload);
    logger.info(`Step 3 complete. Posted agent reply to conversation ${conversationId}.`);

    // Final step: Set the status correctly
    await helpScoutClient.patch(`/conversations/${conversationId}`, [{
      op: 'replace',
      path: '/status',
      value: input.status,
    }]);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Successfully created and sent outbound conversation ${conversationId}.`,
          newConversationId: conversationId,
        }, null, 2),
      }],
    };
  }

  private async deleteConversation(args: unknown): Promise<CallToolResult> {
    const input = DeleteConversationInputSchema.parse(args);
    const { helpScoutClient } = this.services.resolve(['helpScoutClient']);

    await helpScoutClient.delete(`/conversations/${input.conversationId}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Conversation ${input.conversationId} has been permanently deleted.`,
        }, null, 2),
      }],
    };
  }

  private async searchConversations(args: unknown): Promise<CallToolResult> {
    const input = SearchConversationsInputSchema.parse(args);
    const { helpScoutClient, logger } = this.services.resolve(['helpScoutClient', 'logger']);
    
    const queryParams: Record<string, unknown> = {
      page: 1,
      size: input.limit,
      sortField: input.sort,
      sortOrder: input.order,
    };

    // Add HelpScout query parameter for content/body search
    if (input.query) {
      queryParams.query = input.query;
    }

    if (input.inboxId) queryParams.mailbox = input.inboxId;
    if (input.tag) queryParams.tag = input.tag;
    if (input.createdAfter) queryParams.modifiedSince = input.createdAfter;

    // Handle status parameter with helpful guidance
    if (input.status) {
      queryParams.status = input.status;
    } else if (input.query || input.tag) {
      // If search criteria are provided but no status, default to 'active' with a warning
      queryParams.status = 'active';
      logger.warn('No status specified for conversation search, defaulting to "active". For comprehensive results across all statuses, use comprehensiveConversationSearch tool.', {
        query: input.query,
        tag: input.tag,
      });
    }

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    
    let conversations = response._embedded?.conversations || [];

    // Apply additional filtering
    if (input.createdBefore) {
      const beforeDate = new Date(input.createdBefore);
      conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
    }

    // Apply field selection if specified
    if (input.fields && input.fields.length > 0) {
      conversations = conversations.map(conv => {
        const filtered: Partial<Conversation> = {};
        input.fields!.forEach(field => {
          if (field in conv) {
            (filtered as any)[field] = (conv as any)[field];
          }
        });
        return filtered as Conversation;
      });
    }

    const results = {
      results: conversations,
      pagination: response.page,
      nextCursor: response._links?.next?.href,
      searchInfo: {
        query: input.query,
        status: queryParams.status || 'all',
        appliedDefaults: !input.status && (input.query || input.tag) ? ['status: active'] : undefined,
        searchGuidance: conversations.length === 0 ? [
          'If no results found, try:',
          '1. Use comprehensiveConversationSearch for multi-status search',
          '2. Try different status values: active, pending, closed, spam',
          '3. Broaden search terms or extend time range',
          '4. Check if inbox ID is correct'
        ] : undefined,
      },
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }

  private async getConversationSummary(args: unknown): Promise<CallToolResult> {
    const input = GetConversationSummaryInputSchema.parse(args);
    const { helpScoutClient, config } = this.services.resolve(['helpScoutClient', 'config']);
    
    // Get conversation details
    const conversation = await helpScoutClient.get<Conversation>(`/conversations/${input.conversationId}`);
    
    // Get threads to find first customer message and latest staff reply
    const threadsResponse = await helpScoutClient.get<PaginatedResponse<Thread>>(
      `/conversations/${input.conversationId}/threads`,
      { page: 1, size: 50 }
    );
    
    const threads = threadsResponse._embedded?.threads || [];
    const customerThreads = threads.filter(t => t.type === 'customer');
    const staffThreads = threads.filter(t => t.type === 'message' && t.createdBy);
    
    const firstCustomerMessage = customerThreads.sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )[0];
    
    const latestStaffReply = staffThreads.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    const summary = {
      conversation: {
        id: conversation.id,
        subject: conversation.subject,
        status: conversation.status,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        customer: conversation.customer,
        assignee: conversation.assignee,
        tags: conversation.tags,
      },
      firstCustomerMessage: firstCustomerMessage ? {
        id: firstCustomerMessage.id,
        body: config.security.allowPii ? firstCustomerMessage.body : '[REDACTED]',
        createdAt: firstCustomerMessage.createdAt,
        customer: firstCustomerMessage.customer,
      } : null,
      latestStaffReply: latestStaffReply ? {
        id: latestStaffReply.id,
        body: config.security.allowPii ? latestStaffReply.body : '[REDACTED]',
        createdAt: latestStaffReply.createdAt,
        createdBy: latestStaffReply.createdBy,
      } : null,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  private async getThreads(args: unknown): Promise<CallToolResult> {
    const input = GetThreadsInputSchema.parse(args);
    const { helpScoutClient, config } = this.services.resolve(['helpScoutClient', 'config']);
    
    const response = await helpScoutClient.get<PaginatedResponse<Thread>>(
      `/conversations/${input.conversationId}/threads`,
      {
        page: 1,
        size: input.limit,
      }
    );

    const threads = response._embedded?.threads || [];
    
    // Redact PII if configured
    const processedThreads = threads.map(thread => ({
      ...thread,
      body: config.security.allowPii ? thread.body : '[REDACTED]',
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            conversationId: input.conversationId,
            threads: processedThreads,
            pagination: response.page,
            nextCursor: response._links?.next?.href,
          }, null, 2),
        },
      ],
    };
  }

  private async getServerTime(): Promise<CallToolResult> {
    const now = new Date();
    const serverTime: ServerTime = {
      isoTime: now.toISOString(),
      unixTime: Math.floor(now.getTime() / 1000),
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(serverTime, null, 2),
        },
      ],
    };
  }

  private async listAllInboxes(args: unknown): Promise<CallToolResult> {
    const input = args as { limit?: number };
    const { helpScoutClient } = this.services.resolve(['helpScoutClient']);
    const limit = input.limit || 100;
    
    const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
      page: 1,
      size: limit,
    });

    const inboxes = response._embedded?.mailboxes || [];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            inboxes: inboxes.map(inbox => ({
              id: inbox.id,
              name: inbox.name,
              email: inbox.email,
              createdAt: inbox.createdAt,
              updatedAt: inbox.updatedAt,
            })),
            totalInboxes: inboxes.length,
            usage: 'Use the "id" field from these results in your conversation searches',
            nextSteps: [
              'To search in a specific inbox, use the inbox ID with comprehensiveConversationSearch or searchConversations',
              'To search across all inboxes, omit the inboxId parameter',
            ],
          }, null, 2),
        },
      ],
    };
  }

  private async advancedConversationSearch(args: unknown): Promise<CallToolResult> {
    const input = AdvancedConversationSearchInputSchema.parse(args);
    const { helpScoutClient } = this.services.resolve(['helpScoutClient']);

    // Build HelpScout query syntax
    const queryParts: string[] = [];

    // Content/body search
    if (input.contentTerms && input.contentTerms.length > 0) {
      const bodyQueries = input.contentTerms.map(term => `body:"${term}"`);
      queryParts.push(`(${bodyQueries.join(' OR ')})`);
    }

    // Subject search
    if (input.subjectTerms && input.subjectTerms.length > 0) {
      const subjectQueries = input.subjectTerms.map(term => `subject:"${term}"`);
      queryParts.push(`(${subjectQueries.join(' OR ')})`);
    }

    // Email searches
    if (input.customerEmail) {
      queryParts.push(`email:"${input.customerEmail}"`);
    }

    // Handle email domain search (HelpScout supports domain-only searches)
    if (input.emailDomain) {
      const domain = input.emailDomain.replace('@', ''); // Remove @ if present
      queryParts.push(`email:"${domain}"`);
    }

    // Tag search
    if (input.tags && input.tags.length > 0) {
      const tagQueries = input.tags.map(tag => `tag:"${tag}"`);
      queryParts.push(`(${tagQueries.join(' OR ')})`);
    }

    // Build final query
    const queryString = queryParts.length > 0 ? queryParts.join(' AND ') : undefined;

    // Set up query parameters
    const queryParams: Record<string, unknown> = {
      page: 1,
      size: input.limit || 50,
      sortField: 'createdAt',
      sortOrder: 'desc',
    };

    if (queryString) {
      queryParams.query = queryString;
    }

    if (input.inboxId) queryParams.mailbox = input.inboxId;
    if (input.status) queryParams.status = input.status;
    if (input.createdAfter) queryParams.modifiedSince = input.createdAfter;

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    
    let conversations = response._embedded?.conversations || [];

    // Apply additional client-side filtering
    if (input.createdBefore) {
      const beforeDate = new Date(input.createdBefore);
      conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: conversations,
            searchQuery: queryString,
            searchCriteria: {
              contentTerms: input.contentTerms,
              subjectTerms: input.subjectTerms,
              customerEmail: input.customerEmail,
              emailDomain: input.emailDomain,
              tags: input.tags,
            },
            pagination: response.page,
            nextCursor: response._links?.next?.href,
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Performs comprehensive conversation search across multiple statuses
   * @param args - Search parameters including search terms, statuses, and timeframe
   * @returns Promise<CallToolResult> with search results organized by status
   * @example
   * comprehensiveConversationSearch({
   *   searchTerms: ["urgent", "billing"],
   *   timeframeDays: 30,
   *   inboxId: "123456"
   * })
   */
  private async comprehensiveConversationSearch(args: unknown): Promise<CallToolResult> {
    const input = MultiStatusConversationSearchInputSchema.parse(args);
    
    const searchContext = this.buildComprehensiveSearchContext(input);
    const searchResults = await this.executeMultiStatusSearch(searchContext);
    const summary = this.formatComprehensiveSearchResults(searchResults, searchContext);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  /**
   * Build search context from input parameters
   */
  private buildComprehensiveSearchContext(input: z.infer<typeof MultiStatusConversationSearchInputSchema>) {
    const createdAfter = input.createdAfter || this.calculateTimeRange(input.timeframeDays);
    const searchQuery = this.buildSearchQuery(input.searchTerms, input.searchIn);
    
    return {
      input,
      createdAfter,
      searchQuery,
    };
  }

  /**
   * Calculate time range for search
   */
  private calculateTimeRange(timeframeDays: number): string {
    const timeRange = new Date();
    timeRange.setDate(timeRange.getDate() - timeframeDays);
    return timeRange.toISOString();
  }

  /**
   * Build Help Scout search query from terms and search locations
   */
  private buildSearchQuery(terms: string[], searchIn: string[]): string {
    const queries: string[] = [];
    
    for (const term of terms) {
      const termQueries: string[] = [];
      
      if (searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.BODY) || searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.BOTH)) {
        termQueries.push(`body:"${term}"`);
      }
      
      if (searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.SUBJECT) || searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.BOTH)) {
        termQueries.push(`subject:"${term}"`);
      }
      
      if (termQueries.length > 0) {
        queries.push(`(${termQueries.join(' OR ')})`);
      }
    }
    
    return queries.join(' OR ');
  }

  /**
   * Execute search across multiple statuses with error handling
   */
  private async executeMultiStatusSearch(context: {
    input: z.infer<typeof MultiStatusConversationSearchInputSchema>;
    createdAfter: string;
    searchQuery: string;
  }) {
    const { input, createdAfter, searchQuery } = context;
    const { logger } = this.services.resolve(['logger']);
    const allResults: Array<{
      status: string;
      totalCount: number;
      conversations: Conversation[];
      searchQuery: string;
    }> = [];

    for (const status of input.statuses) {
      try {
        const result = await this.searchSingleStatus({
          status,
          searchQuery,
          createdAfter,
          limitPerStatus: input.limitPerStatus,
          inboxId: input.inboxId,
          createdBefore: input.createdBefore,
        });
        allResults.push(result);
      } catch (error) {
        logger.warn('Failed to search conversations for status', {
          status,
          error: error instanceof Error ? error.message : String(error),
        });
        
        allResults.push({
          status,
          totalCount: 0,
          conversations: [],
          searchQuery,
        });
      }
    }

    return allResults;
  }

  /**
   * Search conversations for a single status
   */
  private async searchSingleStatus(params: {
    status: string;
    searchQuery: string;
    createdAfter: string;
    limitPerStatus: number;
    inboxId?: string;
    createdBefore?: string;
  }) {
    const { helpScoutClient } = this.services.resolve(['helpScoutClient']);
    const queryParams: Record<string, unknown> = {
      page: 1,
      size: params.limitPerStatus,
      sortField: TOOL_CONSTANTS.DEFAULT_SORT_FIELD,
      sortOrder: TOOL_CONSTANTS.DEFAULT_SORT_ORDER,
      query: params.searchQuery,
      status: params.status,
      modifiedSince: params.createdAfter,
    };

    if (params.inboxId) {
      queryParams.mailbox = params.inboxId;
    }

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    let conversations = response._embedded?.conversations || [];

    // Apply client-side createdBefore filter
    if (params.createdBefore) {
      const beforeDate = new Date(params.createdBefore);
      conversations = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
    }

    return {
      status: params.status,
      totalCount: response.page?.totalElements || conversations.length,
      conversations,
      searchQuery: params.searchQuery,
    };
  }

  /**
   * Format comprehensive search results into summary response
   */
  private formatComprehensiveSearchResults(
    allResults: Array<{
      status: string;
      totalCount: number;
      conversations: Conversation[];
      searchQuery: string;
    }>,
    context: {
      input: z.infer<typeof MultiStatusConversationSearchInputSchema>;
      createdAfter: string;
      searchQuery: string;
    }
  ) {
    const { input, createdAfter, searchQuery } = context;
    const totalConversations = allResults.reduce((sum, result) => sum + result.conversations.length, 0);
    const totalAvailable = allResults.reduce((sum, result) => sum + result.totalCount, 0);

    return {
      searchTerms: input.searchTerms,
      searchQuery,
      searchIn: input.searchIn,
      timeframe: {
        createdAfter,
        createdBefore: input.createdBefore,
        days: input.timeframeDays,
      },
      totalConversationsFound: totalConversations,
      totalAvailableAcrossStatuses: totalAvailable,
      resultsByStatus: allResults,
      searchTips: totalConversations === 0 ? [
        'Try broader search terms or increase the timeframe',
        'Check if the inbox ID is correct',
        'Consider searching without status restrictions first',
        'Verify that conversations exist for the specified criteria'
      ] : undefined,
    };
  }
}

export const toolHandler = new ToolHandler();