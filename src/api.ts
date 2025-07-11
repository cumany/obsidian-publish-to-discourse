import { App, requestUrl, TFile } from 'obsidian';
import { DiscourseSyncSettings } from './config';
import { NotifyUser } from './notification';
import { t } from './i18n';

// 生成随机边界字符串
const genBoundary = (): string => {
    return 'ObsidianBoundary' + Math.random().toString(16).substring(2);
};

export class DiscourseAPI {
    constructor(
        private app: App,
        private settings: DiscourseSyncSettings
    ) {}

    // 上传图片到Discourse
    async uploadImage(file: TFile): Promise<{shortUrl: string, fullUrl?: string} | null> {
        try {
            const imgfile = await this.app.vault.readBinary(file);
            const boundary = genBoundary();
            const sBoundary = '--' + boundary + '\r\n';
            const imgForm = `${sBoundary}Content-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: image/${file.extension}\r\n\r\n`;

            let body = '';
            body += `\r\n${sBoundary}Content-Disposition: form-data; name="type"\r\n\r\ncomposer\r\n`;
            body += `${sBoundary}Content-Disposition: form-data; name="synchronous"\r\n\r\ntrue\r\n`;

            const eBoundary = '\r\n--' + boundary + '--\r\n';
            const imgFormArray = new TextEncoder().encode(imgForm);
            const bodyArray = new TextEncoder().encode(body);
            const endBoundaryArray = new TextEncoder().encode(eBoundary);

            const formDataArray = new Uint8Array(imgFormArray.length + imgfile.byteLength + bodyArray.length + endBoundaryArray.length);
            formDataArray.set(imgFormArray, 0);
            formDataArray.set(new Uint8Array(imgfile), imgFormArray.length);
            formDataArray.set(bodyArray, imgFormArray.length + imgfile.byteLength);
            formDataArray.set(endBoundaryArray, imgFormArray.length + bodyArray.length + imgfile.byteLength);

            const url = `${this.settings.baseUrl}/uploads.json`;
            const headers: Record<string, string> = {
                "User-Api-Key": this.settings.userApiKey,
                "Content-Type": `multipart/form-data; boundary=${boundary}`
            };

            const response = await requestUrl({
                url: url,
                method: "POST",
                body: formDataArray.buffer,
                throw: false,
                headers: headers,
            });

            if (response.status == 200) {
                const jsonResponse = response.json;
                let fullUrl: string | undefined;
                
                // 处理完整URL的拼接
                if (jsonResponse.url) {
                    // 如果返回的url已经是完整URL（包含http/https），直接使用
                    if (jsonResponse.url.startsWith('http://') || jsonResponse.url.startsWith('https://')) {
                        fullUrl = jsonResponse.url;
                    } else {
                        // 如果是相对路径，需要与baseUrl拼接
                        const baseUrl = this.settings.baseUrl.replace(/\/$/, ''); // 移除尾部斜杠
                        const urlPath = jsonResponse.url.startsWith('/') ? jsonResponse.url : `/${jsonResponse.url}`;
                        fullUrl = `${baseUrl}${urlPath}`;
                    }
                }
                
                return {
                    shortUrl: jsonResponse.short_url,
                    fullUrl: fullUrl
                };
            } else {
                new NotifyUser(this.app, `Error uploading image: ${response.status}`).open();
                return null;
            }
        } catch (error) {
            new NotifyUser(this.app, `Exception while uploading image: ${error}`).open();
            return null;
        }
    }

    // 创建新帖子
    async createPost(title: string, content: string, category: number, tags: string[]): Promise<{ success: boolean; postId?: number; topicId?: number; error?: string }> {
        const url = `${this.settings.baseUrl}/posts.json`;
        const headers: Record<string, string> = {
            "User-Api-Key": this.settings.userApiKey,
            "Content-Type": "application/json"
        };

        try {
            const response = await requestUrl({
                url,
                method: "POST",
                contentType: "application/json",
                body: JSON.stringify({
                    title: title,
                    raw: content,
                    category: category,
                    tags: tags || []
                }),
                headers,
                throw: false
            });

            if (response.status === 200) {
                const responseData = response.json;
                if (responseData && responseData.id) {
                    return {
                        success: true,
                        postId: responseData.id,
                        topicId: responseData.topic_id
                    };
                } else {
                    return {
                        success: false,
                        error: t('POST_ID_ERROR')
                    };
                }
            } else {
                try {
                    const errorResponse = response.json;
                    if (errorResponse.errors && errorResponse.errors.length > 0) {
                        return { 
                            success: false,
                            error: errorResponse.errors.join('\n')
                        };
                    }
                    if (errorResponse.error) {
                        return {
                            success: false,
                            error: errorResponse.error
                        };
                    }
                } catch (parseError) {
                    return {
                        success: false,
                        error: `${t('PUBLISH_FAILED')} (${response.status})`
                    };
                }
                return {
                    success: false,
                    error: `${t('PUBLISH_FAILED')} (${response.status})`
                };
            }
        } catch (error) {
            return { 
                success: false,
                error: `${t('PUBLISH_FAILED')}: ${error.message || t('UNKNOWN_ERROR')}`
            };
        }
    }

    // 更新帖子
    async updatePost(postId: number, topicId: number, title: string, content: string, category: number, tags: string[]): Promise<{ success: boolean; error?: string }> {
        const postEndpoint = `${this.settings.baseUrl}/posts/${postId}`;
        const topicEndpoint = `${this.settings.baseUrl}/t/${topicId}`;
        const headers: Record<string, string> = {
            "User-Api-Key": this.settings.userApiKey,
            "Content-Type": "application/json"
        };
        
        try {
            // 首先更新帖子内容
            const postResponse = await requestUrl({
                url: postEndpoint,
                method: "PUT",
                contentType: "application/json",
                body: JSON.stringify({
                    raw: content,
                    edit_reason: "Updated from Obsidian"
                }),
                headers,
                throw: false
            });
            
            if (postResponse.status !== 200) {
                return { 
                    success: false, 
                    error: `${t('UPDATE_FAILED')} (${postResponse.status})` 
                };
            }
            
            // 然后更新主题（标题、分类和标签）
            const topicResponse = await requestUrl({
                url: topicEndpoint,
                method: "PUT",
                contentType: "application/json",
                body: JSON.stringify({
                    title: title,
                    category_id: category,
                    tags: tags || []
                }),
                headers,
                throw: false
            });
            
            if (topicResponse.status === 200) {
                return { success: true };
            } else {
                try {
                    const errorResponse = topicResponse.json;
                    if (errorResponse.errors && errorResponse.errors.length > 0) {
                        return { 
                            success: false,
                            error: errorResponse.errors.join('\n')
                        };
                    }
                    if (errorResponse.error) {
                        return {
                            success: false,
                            error: errorResponse.error
                        };
                    }
                } catch (parseError) {
                    return {
                        success: false,
                        error: `${t('UPDATE_FAILED')} (${topicResponse.status})`
                    };
                }
                return {
                    success: false,
                    error: `${t('UPDATE_FAILED')} (${topicResponse.status})`
                };
            }
        } catch (error) {
            return { 
                success: false,
                error: `${t('UPDATE_FAILED')}: ${error.message || t('UNKNOWN_ERROR')}`
            };
        }
    }

    // 获取分类列表
    async fetchCategories(): Promise<{ id: number; name: string }[]> {
        try {
            const url = `${this.settings.baseUrl}/categories.json?include_subcategories=true`;
            const headers: Record<string, string> = {
                "User-Api-Key": this.settings.userApiKey
            };
            
            const response = await requestUrl({
                url,
                method: "GET",
                headers,
                throw: false
            });
            
            if (response.status === 200) {
                const data = response.json;
                const categories: { id: number; name: string }[] = [];
                
                if (data && data.category_list && data.category_list.categories) {
                    data.category_list.categories.forEach((category: any) => {
                        categories.push({
                            id: category.id,
                            name: category.name
                        });
                        
                        // 添加子分类
                        if (category.subcategory_list) {
                            category.subcategory_list.forEach((subcategory: any) => {
                                categories.push({
                                    id: subcategory.id,
                                    name: `${category.name} > ${subcategory.name}`
                                });
                            });
                        }
                    });
                }
                
                return categories;
            } else {
                new NotifyUser(this.app, `Error fetching categories: ${response.status}`).open();
                return [];
            }
        } catch (error) {
            new NotifyUser(this.app, `Exception while fetching categories: ${error}`).open();
            return [];
        }
    }

    // 获取标签列表
    async fetchTags(): Promise<{ name: string; canCreate: boolean }[]> {
        try {
            const url = `${this.settings.baseUrl}/tags.json`;
            const headers: Record<string, string> = {
                "User-Api-Key": this.settings.userApiKey
            };
            
            const response = await requestUrl({
                url,
                method: "GET",
                headers,
                throw: false
            });
            
            if (response.status === 200) {
                const data = response.json;
                const tags: { name: string; canCreate: boolean }[] = [];
                
                if (data && data.tags) {
                    const canCreateTags = await this.checkCanCreateTags();
                    
                    // 处理所有标签（包括tag_groups中的标签）
                    const allTags = new Map<string, { name: string; count: number }>();
                    
                    // 添加普通标签
                    data.tags.forEach((tag: any) => {
                        allTags.set(tag.name, { name: tag.name, count: tag.count || 0 });
                    });
                    
                    // 添加tag_groups中的标签
                    if (data.extras && data.extras.tag_groups) {
                        data.extras.tag_groups.forEach((group: any) => {
                            if (group.tags) {
                                group.tags.forEach((tag: any) => {
                                    // 如果标签已存在，取较大的count值
                                    const existing = allTags.get(tag.name);
                                    if (existing) {
                                        existing.count = Math.max(existing.count, tag.count || 0);
                                    } else {
                                        allTags.set(tag.name, { name: tag.name, count: tag.count || 0 });
                                    }
                                });
                            }
                        });
                    }
                    
                    // 按count数量排序，转换为最终格式
                    const sortedTags = Array.from(allTags.values())
                        .sort((a, b) => b.count - a.count)
                        .map(tag => ({
                            name: tag.name,
                            canCreate: canCreateTags
                        }));
                    
                    tags.push(...sortedTags);
                }
                
                return tags;
            } else {
                new NotifyUser(this.app, `Error fetching tags: ${response.status}`).open();
                return [];
            }
        } catch (error) {
            new NotifyUser(this.app, `Exception while fetching tags: ${error}`).open();
            return [];
        }
    }

    // 检查是否可以创建标签
    async checkCanCreateTags(): Promise<boolean> {
        try {
            const url = `${this.settings.baseUrl}/site.json`;
            const headers: Record<string, string> = {
                "User-Api-Key": this.settings.userApiKey
            };
            
            const response = await requestUrl({
                url,
                method: "GET",
                headers,
                throw: false
            });
            
            if (response.status === 200) {
                const data = response.json;
                if (data && data.can_create_tag) {
                    return data.can_create_tag;
                }
            }
            
            return false;
        } catch (error) {
            return false;
        }
    }

    // 测试API密钥
    async testApiKey(): Promise<{ success: boolean; message: string }> {
        if (!this.settings.baseUrl || !this.settings.userApiKey) {
            return {
                success: false,
                message: t('MISSING_SETTINGS')
            };
        }
        
        try {
            const url = `${this.settings.baseUrl}/site.json`;
            const headers: Record<string, string> = {
                "User-Api-Key": this.settings.userApiKey
            };
            
            const response = await requestUrl({
                url,
                method: "GET",
                headers,
                throw: false
            });
            
            if (response.status === 200) {
                const data = response.json;
                if (data) {
                    return {
                        success: true,
                        message: t('API_TEST_SUCCESS')
                    };
                } else {
                    return {
                        success: false,
                        message: t('API_KEY_INVALID')
                    };
                }
            } else {
                return {
                    success: false,
                    message: `${t('API_KEY_INVALID')} (${response.status})`
                };
            }
        } catch (error) {
            return {
                success: false,
                message: `${t('API_KEY_INVALID')}: ${error.message || t('UNKNOWN_ERROR')}`
            };
        }
    }

    // 获取特定主题的标签和分类信息
    async fetchTopicInfo(topicId: number): Promise<{ tags: string[], categoryId?: number }> {
        try {
            const url = `${this.settings.baseUrl}/t/${topicId}.json`;
            const headers: Record<string, string> = {
                "User-Api-Key": this.settings.userApiKey
            };
            
            const response = await requestUrl({
                url,
                method: "GET",
                headers,
                throw: false
            });
            
            if (response.status === 200) {
                const data = response.json;
                return {
                    tags: data?.tags || [],
                    categoryId: data?.category_id
                };
            }
            
            return { tags: [] };
        } catch (error) {
            new NotifyUser(this.app, `Exception while fetching topic info: ${error}`).open();
            return { tags: [] };
        }
    }

    // 获取特定主题的标签
    async fetchTopicTags(topicId: number): Promise<string[]> {
        try {
            const topicInfo = await this.fetchTopicInfo(topicId);
            return topicInfo.tags;
        } catch (error) {
            new NotifyUser(this.app, `Exception while fetching topic tags: ${error}`).open();
            return [];
        }
    }
} 