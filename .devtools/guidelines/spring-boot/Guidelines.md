# Spring Boot Guidelines

## Architecture

Each application consists of four layers/modules with clearly defined dependencies and responsibilities:

### Domain Objects
* Domain objects are simple POJOs.
* Domain objects are always immutable.
* Use Lombok's `@Value` and `@Builder` annotations on domain object classes.
* Comment each domain object and its properties with `javadoc` comments.
* Never use inheritance for modeling domain objects.
* Use validation annotations on the properties of a domain object. The actual validation is handled by using Spring's `@Valid` annotation at layer boundaries.
* Objects that contain the data required for a command (e.g. `OrderCreation` or `OrderMutation`) are also domain objects.
* Put domain objects into the package `domain` under application's root package. Use further sub-packages to structure by domain (e.g. `order`) 

### Output adapters
* Output adapters encapsulate external services and subsystems (this includes libraries).
* Output adapters depend on the domain objects and can accept them as parameters and return them as return values.
* Their API should not leak details about the underlying service or subsystem.
* Typical output adapters are data stores or specific-purpose libraries (e.g. PDF generation, QR-code detection).
* Put output adapters into the package `output` under the application's root package. Use further sub-packages to structure by subsystem (e.g. `store` for data stores or `pdf` for a PDF library).
* Use `mapstruct` to map between domain objects and output adapters specific types (e.g., between the domain object `Order` and the JPA entity `OrderEntity`).
* Don't define an interface for an adapter unless there are multiple implementations.
* Naming convention:
  * The name of an output adapter typically consists of the domain and the adapter type, e.g. `OrderStore`.
  * If there are multiple implementations of an adapter, use the generic name for the interface and a specialized name for the implementation, e.g. `Mailer` and `SmtpMailer`.  
* Output adapters are beans annotated with `@Component` or one of its subtypes.

### Application
* Contains the application's logic (commands) and depends on the domain model and output adapters.
* Each command that the application implements goes into a separate class, e.g. `GetOrder`, `CreateOrder` or `CalculateOrderTotal`.
  * The class has a single public method to invoke the functionality, e.g. `Order createOrder(String tenantId, @Valid OrderCreation orderCreation)`.
  * There might be a number of private methods to further structure the implementation.
  * The class is a bean annotated with `@Component`.
* If there is shared functionality between such command classes, it can be extracted into a package-private helper command.
* A command should always validate its input data, e.g., by using `@Valid` on its parameters.
* A command should perform authorization.

### Input adapters
* Input adapters are what actually drive the application. These can be internal triggers (events like application start-up, timers/cronjobs), or APIs that the application exposes.
* Input adapters depend on the domain model and the application.
* Input adapters can accept/expose domain objects as part of their external API. However, if different representations are required (e.g., in a versioned API), use `mapstruct` for the mapping.
* Put input adapters into the package `input` under the application's root package. Use further sub-packages to structure by subsystem (e.g., `web` for Web APIs like REST controllers, or `timer` for scheduled jobs).
* Input adapters are beans annotated with `@Component` or one of its subtypes.
* Naming convention:
  * The name of an input adapter typically consists of the domain and the adapter type, e.g. `OrderApi`.
  * Optionally, an additional noun can indicate the functionality triggered by the input adapter, e.g. `OrderArchivalJob`.

## Prefer Constructor Injection over Field/Setter Injection
* Declare all the mandatory dependencies as `final` fields and inject them through the constructor.
* Use Lombok's `@RequiredArgsContructor` to generate the constructor.
* Spring will auto-detect if there is only one constructor, no need to add `@Autowired` on the constructor.
* Avoid field/setter injection in production code.

## Prefer package-private over public for Spring components
* Declare Controllers, their request-handling methods, `@Configuration` classes and `@Bean` methods with default (package-private) visibility whenever possible. There's no obligation to make everything `public`.

## Configuration

### Organize Configuration with Typed Properties
* Group application-specific configuration properties with a common prefix in `application.yml`.
* Bind them to `@ConfigurationProperties` classes with validation annotations so that the application will fail fast if the configuration is invalid.
* Prefer environment variables instead of profiles for passing different configuration properties for different environments.
* `@ConfigurationProperties` classes should be placed next to consuming bean.

### Configuration beans
* Place beans that configure a certain subsystem into the corresponding package, e.g.
  * a configuration implementing `WebMvcConfigurer` should go into `input.web`
  * a bean implementing `Filter` should go into `input.web`
  * a `SecurityFilterChain` bean should go into `input.web`

### Secrets and sensitive configuration
* Never put secrets or sensitive configuration into `application.yml`, the source code or any other file that is subject to version control.

## Define Clear Transaction Boundaries
* Define each Service-layer method as a transactional unit.
* Annotate query-only methods with `@Transactional(readOnly = true)`.
* Annotate data-modifying methods with `@Transactional`.
* Limit the code inside each transaction to the smallest necessary scope.
* Only call network services other than the database in a transaction when a short (less than one second) time-out is guaranteed.

## Use generic exceptions where possible and avoid checked exceptions
* Use generic exceptions instead of creating custom exceptions, e.g., use `EntityNotFoundException` instead of creating an `OrderNotFoundException`.
* Create specific exceptions only when the calling code can reasonably handle that specific error condition, *and* it needs to distinguish this error condition from others.

## Disable Open Session in View Pattern
* While using Spring Data JPA, disable the Open Session in View filter by setting ` spring.jpa.open-in-view=false` in `application.properties/yml.`

## Follow REST API Design Principles
* **Versioned, resource-oriented URLs:** Structure your endpoints as `/api/v{version}/resources` (e.g. `/api/v1/orders`).
* **Consistent patterns for collections and sub-resources:** Keep URL conventions uniform (for example, `/posts` for posts collection and `/posts/{slug}/comments` for comments of a specific post).
* Use the appropriate HTTP method:
  * `GET` for querying resources
  * `POST` for creating resources
  * `PUT` for modifying existing resources
  * `DELETE` for deleting resources
* Use SpringDoc to generate OpenAPI schemas and Swagger documentation. Prefer SpringDoc's Javadoc extension instead of using annotation where possible. 
* Use Spring Data's `Pageable` and `Page` for collection resources that may contain an unbounded number of items.
* Use camelCase for JSON property names consistently.

## Centralize Exception Handling
* Define a global handler class annotated with `@ControllerAdvice` (or `@RestControllerAdvice` for REST APIs) using `@ExceptionHandler` methods to handle specific exceptions.
* Put the global handler class next to the actual controllers, typically into the `input.web` package under the application's root package.
* Return consistent error responses. Use the ProblemDetails response format ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)).

## Actuator
* Expose only essential actuator endpoints (such as `/health`, `/info`, `/metrics`) without requiring authentication. All the other actuator endpoints must be secured.

## Internationalization with ResourceBundles
* Externalize all user-facing text such as labels, prompts, and messages into ResourceBundles rather than embedding them in code.

## Use Testcontainers for integration tests
* Spin up real services (databases, message brokers, etc.) in your integration tests to mirror production environments.

## Use random port for integration tests
* When writing integration tests, start the application on a random available port to avoid port conflicts by annotating the test class with:

    ```java
    @SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
    ```

## Logging
### Use a proper logging framework.**  
Never use `System.out.println()` for application logging. Rely on SLF4J and add Lombok's `@Slf4j` annotation to classes using a logger. 

### Protect sensitive data.  
Ensure that no credentials, personal information, or other confidential details ever appear in log output.

### Guard expensive log calls.  
When building verbose messages at `DEBUG` or `TRACE` level, especially those involving method calls or complex string concatenations, wrap them in a level check or use suppliers:

```java
if (log.isDebugEnabled()) {
    log.debug("Detailed state: {}", computeExpensiveDetails());
}

// using Supplier/Lambda expression
log.atDebug()
	.setMessage("Detailed state: {}")
	.addArgument(() -> computeExpensiveDetails())
    .log();
```
