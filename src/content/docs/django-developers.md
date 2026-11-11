---
title: Ghuri for Django developers
description: A side-by-side cheat sheet mapping Django and Django REST framework code to Ghuri.
---

If you know Django, you already know most of Ghuri. This page maps what you write in Python to
what you write in TypeScript. Keep it open while you work through the
[tutorial](/docs/tutorial/part-1-models/).

## The rules of translation

Almost every difference comes from five mechanical rules:

1. **`snake_case` options and methods become `camelCase`.** `max_length` → `maxLength`,
   `order_by` → `orderBy`, `perform_create` → `performCreate`. Settings keys stay `UPPER_SNAKE`,
   and database columns stay `snake_case`.
2. **Keyword arguments become an object.** `filter(title__icontains='x')` →
   `filter({ title__icontains: 'x' })`. The `__` lookup syntax is unchanged.
3. **Anything that touches the database is `async`.** You `await` QuerySets, `get()`, `save()`,
   related objects (`await post.author`) and serializer output.
4. **Nothing is discovered by name.** Apps import their models, migrations and admin modules;
   `INSTALLED_APPS` holds classes; `ROOT_URLCONF` holds the pattern array.
5. **Settings are a function of `env`.** On Workers, configuration and resources arrive with
   each request, so `settings.ts` exports `defineSettings((env) => ({...}))`.

## Project and commands

| Django | Ghuri |
|---|---|
| `django-admin startproject mysite` | `npm create ghuri@latest mysite` |
| `python manage.py startapp blog` | `npx ghuri startapp blog` |
| `python manage.py runserver` | `npm run dev` (`ghuri runserver`) |
| `python manage.py makemigrations` | `npx ghuri makemigrations` |
| `python manage.py migrate` | `npx ghuri migrate` (`--remote` for production D1) |
| `python manage.py createsuperuser` | `npx ghuri createsuperuser` |
| `python manage.py shell` | `npx ghuri shell` (top-level `await` works) |
| `python manage.py dumpdata > data.json` | `npx ghuri dumpdata > data.json` |
| `python manage.py test` | `npx ghuri test` (Vitest) |
| `DJANGO_SETTINGS_MODULE` | `"ghuri": { "settings": "src/settings.ts" }` in `package.json` |
| `settings.py`, `urls.py`, `wsgi.py` | `settings.ts`, `urls.ts`, `index.ts` (Workers) / `server.ts` (Node) |
| `apps.py`, `models.py`, `admin.py` | `app.ts`, `models.ts`, `admin.ts` |
| `call_command('migrate')` | `await callCommand('migrate')` |

## Settings

```python title="settings.py"
SECRET_KEY = os.environ['SECRET_KEY']
DEBUG = os.environ.get('DEBUG') == '1'
INSTALLED_APPS = ['django.contrib.auth', 'django.contrib.admin', 'blog']
ROOT_URLCONF = 'mysite.urls'
DATABASES = {'default': dj_database_url.config()}
```

```ts title="src/settings.ts"
export default defineSettings((env) => ({
  SECRET_KEY: env.SECRET_KEY,
  DEBUG: env.DEBUG === 'true',
  INSTALLED_APPS: [AuthConfig, AdminConfig, BlogConfig],
  ROOT_URLCONF: urlpatterns,
  DATABASES: { default: env.DATABASE_URL ? postgres({ url: env.DATABASE_URL }) : d1('DB') },
}))
```

| Django | Ghuri |
|---|---|
| `from django.conf import settings; settings.DEBUG` | `getSettings().DEBUG` |
| `getattr(settings, 'X', default)` | `setting('X', default)` |
| `os.environ['KEY']` | `env.KEY` in settings, `getEnv().KEY` elsewhere |

## Models

```python title="models.py"
class Post(models.Model):
    title = models.CharField(max_length=200)
    slug = models.SlugField(unique=True)
    author = models.ForeignKey(User, on_delete=models.CASCADE, related_name='posts')
    tags = models.ManyToManyField(Tag, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.title
```

```ts title="models.ts"
export class Post extends Model({
  title: new CharField({ maxLength: 200 }),
  slug: new SlugField({ unique: true }),
  author: new ForeignKey(() => User, { onDelete: CASCADE, relatedName: 'posts' }),
  tags: new ManyToManyField(() => Tag, { blank: true }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
}) {
  static Meta = { ordering: ['-createdAt'] }
  toString() { return this.title }
}
```

| Django | Ghuri |
|---|---|
| `models.CASCADE` | `CASCADE` (import from `@ghuri/orm`) |
| `post.author_id` | `post.authorId` |
| `post.author` | `await post.author` |
| `user.post_set.all()` | `await user.postSet.all()` (or the `relatedName`) |
| `post.save(update_fields=['title'])` | `await post.save({ updateFields: ['title'] })` |
| `post.full_clean()` | `await post.fullClean()` |
| `Post._meta.get_field('title')` | `Post._meta.getField('title')` |
| `class Meta: abstract = True` | `static Meta = { abstract: true }` |
| `objects = PublishedManager()` | `static published = new PublishedManager()` |
| `def get_queryset(self)` (manager) | `getQueryset()` |

## Queries

| Django | Ghuri |
|---|---|
| `Post.objects.all()` | `await Post.objects.all()` |
| `Post.objects.filter(published=True)` | `await Post.objects.filter({ published: true })` |
| `.exclude(title__startswith='x')` | `.exclude({ title__startswith: 'x' })` |
| `.order_by('-created_at')` | `.orderBy('-createdAt')` |
| `qs[:10]` | `qs.slice(0, 10)` |
| `qs[10:20]` | `qs.slice(10, 20)` |
| `Post.objects.get(pk=1)` | `await Post.objects.get({ pk: 1 })` |
| `except Post.DoesNotExist:` | `catch (e) { if (e instanceof Post.DoesNotExist) ... }` |
| `get_object_or_404(Post, slug=s)` | `await getObjectOr404(Post.objects, { slug: s })` |
| `qs.first()`, `qs.count()`, `qs.exists()` | `await qs.first()`, `await qs.count()`, `await qs.exists()` |
| `qs.values('id', 'title')` | `await qs.values('id', 'title')` |
| `qs.values_list('id', flat=True)` | `await qs.valuesList('id', { flat: true })` |
| `Post.objects.create(title='x')` | `await Post.objects.create({ title: 'x' })` |
| `obj, created = get_or_create(slug=s, defaults={...})` | `const [obj, created] = await getOrCreate({ slug: s }, { defaults: {...} })` |
| `bulk_create([...])` | `await bulkCreate([...])` |
| `qs.update(published=True)` | `await qs.update({ published: true })` |
| `qs.delete()` | `await qs.delete()` |
| `Q(a=1) \| Q(b=2)` | `Q({ a: 1 }).or(Q({ b: 2 }))` |
| `Q(a=1) & ~Q(c=3)` | `Q({ a: 1 }).and(Q.not({ c: 3 }))` |
| `F('views') + 1` | `F('views').add(1)` |
| `qs.annotate(n=Count('comments'))` | `qs.annotate({ n: Count('comments') })` |
| `qs.aggregate(Avg('views'))` | `await qs.aggregate({ avg: Avg('views') })` (always named) |
| `select_related('author')` | `selectRelated('author')` |
| `prefetch_related('tags')` | `prefetchRelated('tags')` |
| `for p in qs:` | `for await (const p of qs)` or `for (const p of await qs)` |
| `with transaction.atomic():` | `await atomic(async () => { ... })` |
| `transaction.on_commit(fn)` | `onCommit(fn)` |
| `connection.cursor().execute(sql, params)` | `(await connections.get()).execute(sql, params)` |

## URLs and views

| Django | Ghuri |
|---|---|
| `path('posts/<int:id>/', view, name='detail')` | `path('posts/<int:id>/', view, { name: 'detail' })` |
| `re_path(r'^x/$', view)` | `rePath('^x/$', view)` |
| `include('blog.urls')` | `include(blogUrls)` (an imported module or array) |
| `app_name = 'blog'` | `export const appName = 'blog'` |
| `reverse('blog:detail', kwargs={'id': 1})` | `reverse('blog:detail', { id: 1 })` |
| `def view(request, id):` | `function view(c: Context)` with `kwargs(c).id` |
| `request.GET.get('q')` | `c.req.query('q')` |
| `request.POST` | `await c.req.parseBody()` |
| `json.loads(request.body)` | `await c.req.json()` |
| `request.user` | `getUser(c)` |
| `request.session['k'] = v` | `c.get('session')` (see [Authentication](/docs/topics/authentication/)) |
| `JsonResponse(data)` | `json(c, data)` or `c.json(data)` |
| `redirect('home')` | `redirect(c, 'home')` |
| `render(request, 'x.html', ctx)` | `c.html(<Page {...ctx} />)` with Hono JSX |
| `raise Http404` | `throw new Http404()` |
| `class MyView(View): def get(self, request)` | `class MyView extends View { async get(c) }` |
| `MyView.as_view()` | `MyView.asView()` |
| `@login_required` | `loginRequired(view)` |
| `@permission_required('blog.add_post')` | `permissionRequired('blog.add_post')(view)` |
| `@csrf_exempt` | `csrfExempt(view)` |

## Middleware

| Django | Ghuri |
|---|---|
| `def __call__(self, request): response = self.get_response(request)` | `async handle(c, next) { await next(); c.res }` |
| `'django.middleware.security.SecurityMiddleware'` | `SecurityMiddleware` (from `@ghuri/core`) |
| `'django.contrib.sessions.middleware.SessionMiddleware'` | `SessionMiddleware` (from `@ghuri/auth`) |
| `'django.middleware.csrf.CsrfViewMiddleware'` | `CsrfMiddleware` |
| `django-cors-headers` | `CorsMiddleware` + `CORS` setting |

## Admin

| Django | Ghuri |
|---|---|
| `admin.site.register(Post)` | `admin.site.register(Post)` |
| `@admin.register(Post)` | `@admin.register(Post)` |
| `class PostAdmin(admin.ModelAdmin)` | `class PostAdmin extends ModelAdmin<Post>` |
| `list_display = ('title', 'author')` | `listDisplay = ['title', 'author']` |
| `list_filter`, `search_fields` | `listFilter`, `searchFields` |
| `prepopulated_fields = {'slug': ('title',)}` | `prepopulatedFields = { slug: ['title'] }` |
| `inlines = [CommentInline]` | `inlines = [CommentInline]` |
| `class CommentInline(admin.TabularInline): model = Comment` | `class CommentInline extends TabularInline { model = Comment }` |
| `def has_change_permission(self, request, obj=None)` | `async hasChangePermission(c, obj?)` |

## Django REST framework

| DRF | Ghuri |
|---|---|
| `class PostSerializer(serializers.ModelSerializer)` | `class PostSerializer extends ModelSerializer<Post>` |
| `class Meta: model = Post; fields = [...]` | `static Meta = { model: Post, fields: [...] }` |
| `read_only_fields` | `readOnlyFields` |
| `serializers.CharField(source='author.username', read_only=True)` | `new CharField({ source: 'author.username', readOnly: true })` |
| `def validate_title(self, value)` | `validateTitle(value)` |
| `serializer.is_valid(raise_exception=True)` | `await serializer.isValid({ raiseException: true })` |
| `serializer.data` | `await serializer.getData()` |
| `serializer.validated_data` | `serializer.validatedData` |
| `serializer.save(author=request.user)` | `await serializer.save({ author: this.request.user })` |
| `class PostViewSet(viewsets.ModelViewSet)` | `class PostViewSet extends ModelViewSet<Post>` |
| `queryset`, `serializer_class` | `queryset`, `serializerClass` |
| `permission_classes = [IsAuthenticated]` | `permissionClasses = [IsAuthenticated]` |
| `def get_queryset(self)` | `getQueryset()` |
| `def perform_create(self, serializer)` | `async performCreate(serializer)` |
| `@action(detail=True, methods=['post'])` | `@action({ detail: true, methods: ['post'] })` |
| `self.request.data`, `self.request.query_params` | `this.request.data`, `this.request.query` |
| `router = DefaultRouter(); router.register(r'posts', PostViewSet)` | `const router = new DefaultRouter(); router.register('posts', PostViewSet)` |
| `path('api/', include(router.urls))` | `path('api/', include(router.urls))` |
| `@api_view(['GET'])` | `apiView(['GET'])(fn)` |
| `Response(data, status=201)` | `new APIResponse(data, 201)` |
| `REST_FRAMEWORK = {'PAGE_SIZE': 20}` | `REST_FRAMEWORK: { PAGE_SIZE: 20 }` |
| `drf-spectacular` | `SchemaView`, `SwaggerUIView`, `ScalarView` (built in) |
| `rest_framework.authtoken` | `TokenAuthentication`, `obtainAuthToken` from `@ghuri/auth/rest` |
| `djangorestframework-simplejwt` | `JWTAuthentication`, `TokenObtainPairView` from `@ghuri/auth/rest` |

## Auth

| Django | Ghuri |
|---|---|
| `from django.contrib.auth.models import User` | `import { User } from '@ghuri/auth'` |
| `get_user_model()` | `getUserModel()` |
| `User.objects.create_user(username, password=...)` | `await User.objects.createUser({ username, password })` |
| `user.set_password(pw)` / `check_password(pw)` | `await user.setPassword(pw)` / `await user.checkPassword(pw)` |
| `authenticate(request, username=u, password=p)` | `await authenticate(c, { username: u, password: p })` |
| `login(request, user)` / `logout(request)` | `await login(c, user)` / `await logout(c)` |
| `user.has_perm('blog.change_post')` | `await user.hasPerm('blog.change_post')` |
| `class User(AbstractUser)` | `Model({...}, { extends: AbstractUser })` + `AUTH_USER_MODEL` |

Password hashes use Django's `pbkdf2_sha256$<iterations>$<salt>$<hash>` format, so a user table
copied from Django keeps working.

## Signals, cache, commands

| Django | Ghuri |
|---|---|
| `@receiver(post_save, sender=Post)` | `receiver(postSave, { sender: Post })(fn)` |
| `post_save.connect(fn, sender=Post)` | `postSave.connect(fn, { sender: Post })` |
| `def fn(sender, instance, created, **kwargs)` | `async ({ sender, instance, created }) => {}` |
| `from django.core.cache import cache` | `import { cache } from '@ghuri/core'` |
| `cache.set('k', v, 300)` | `await cache.set('k', v, 300)` |
| `cache.get_or_set('k', fn, 300)` | `await cache.getOrSet('k', fn, 300)` |
| `class Command(BaseCommand): def handle(self, *args, **options)` | `class Command extends BaseCommand { async handle(args, io) }` |
| `def add_arguments(self, parser): parser.add_argument('--dry-run')` | `addArguments(parser) { parser.option('--dry-run') }` |
| `self.stdout.write(self.style.SUCCESS('ok'))` | `io.stdout(io.style.success('ok'))` |
| `raise CommandError('...')` | `throw new CommandError('...')` |

## Things that do not exist (yet)

- **Template language.** Use Hono JSX (`.tsx` views) or a frontend framework talking to the API.
- **Forms.** The admin and serializers cover validation; a standalone `@ghuri/forms` is on the
  roadmap.
- **Multi-table inheritance and proxy models.** Use abstract models and composition.
- **Database routers.** Multiple aliases in `DATABASES` work with `using`, but automatic routing
  is on the roadmap.
- **Sync ORM calls.** Every database operation is `async`, everywhere.
- **i18n**, GIS, `contenttypes` generic relations beyond what auth needs.
